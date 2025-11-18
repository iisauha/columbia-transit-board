// server.js v14
// Simplified shuttle logic: use rides only, ignore all walking rides,
// and only keep rides that actually start at the origin stop (EC S or 120 S).

const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const publicDir = path.join(__dirname, "public");

// ---------------- CONFIG ----------------

// Subway – 125th St 1 train stop
const TRANSITER_STOP_URL =
  "https://realtimerail.nyc/transiter/v0.6/systems/us-ny-subway/stops/116";

// TripShot commutePlan endpoint
const TRIPSHOT_COMMUTE_PLAN_URL =
  "https://columbia.tripshot.com/v2/p/commutePlan";

// Region + stops for EC S / 120 S → 96
const TRIPSHOT_REGION_ID = "CA558DDC-D7F2-4B48-9CAC-DEEA1134F820";

// EC S
const EC_S_STOP_ID = "EC00CCCF-1599-454B-A90A-05F7FAD06576";
const EC_S_LOCATION = { lt: 40.8148513609553, lg: -73.9591558764148 };

// 120 S
const S120_STOP_ID = "db0236ef-fbfa-4254-ae30-ea57dee20a00";
const S120_LOCATION = { lt: 40.8102628806603, lg: -73.9624749343461 };

// 96th St stop
const NINETY_SIX_STOP_ID = "A5C97705-8217-4D82-A778-01DAA12322A6";
const NINETY_SIX_LOCATION = { lt: 40.7943928026156, lg: -73.971405716243 };

// TripShot headers
const TRIPSHOT_HEADERS = {
  "Content-Type": "application/json"
};

// ------------- HELPERS -------------

function minutesFromNow(dateISOString) {
  const target = new Date(dateISOString).getTime();
  const now = Date.now();
  const diffMs = target - now;
  return Math.max(0, Math.round(diffMs / 60000));
}

function formatTime(dateISOString) {
  const d = new Date(dateISOString);
  let h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? "pm" : "am";
  h = ((h + 11) % 12) + 1;
  const mm = String(m).padStart(2, "0");
  return `${h}:${mm} ${suffix}`;
}

// Build a fresh TripShot payload for "depart now" origin → 96
function buildTripShotPayload(originName, originLocation, originStopId) {
  const now = new Date();
  const day = {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate()
  };

  return {
    day,
    startPoint: {
      location: originLocation,
      name: originName,
      stop: originStopId
    },
    endPoint: {
      location: NINETY_SIX_LOCATION,
      name: "96",
      stop: NINETY_SIX_STOP_ID
    },
    departAt: now.toISOString(),
    arriveBy: null,
    directOnly: false,
    forUserId: null,
    keepInferiors: false,
    regionId: TRIPSHOT_REGION_ID,
    requestImperial: true,
    travelMode: "Walking"
  };
}

// ------------- SUBWAY API -------------

app.get("/api/subway", async (req, res) => {
  try {
    const r = await fetch(TRANSITER_STOP_URL);
    if (!r.ok) {
      console.error("Transiter HTTP", r.status);
      return res.status(500).json({ error: "Transiter request failed" });
    }
    const data = await r.json();

    const byDest = {};
    for (const st of data.stopTimes || []) {
      const dest = st.trip?.destination?.name || "Unknown";
      const route = st.trip?.route?.shortName || "";
      const t =
        st.departure?.time ||
        st.arrival?.time ||
        st.arrival?.predictedTime ||
        st.departure?.predictedTime;
      if (!t) continue;

      const tsMs = t * 1000;
      const iso = new Date(tsMs).toISOString();

      if (!byDest[dest]) {
        byDest[dest] = { destination: dest, route, departures: [] };
      }
      byDest[dest].departures.push({
        inMinutes: minutesFromNow(iso),
        absolute: formatTime(iso)
      });
    }

    let trains = Object.values(byDest)
      .sort(
        (a, b) =>
          (a.departures[0]?.inMinutes ?? 9999) -
          (b.departures[0]?.inMinutes ?? 9999)
      )
      .map((t) => ({
        destination: t.destination,
        route: t.route,
        departures: t.departures.slice(0, 3)
      }));

    // Filter to South Ferry / Van Cortlandt only
    trains = trains.filter((t) => {
      const d = t.destination.toLowerCase();
      return d.includes("south ferry") || d.includes("van cortlandt");
    });

    res.json({
      stopName: data.name || "125th St",
      trains
    });
  } catch (err) {
    console.error("Subway API error", err);
    res.status(500).json({ error: "Subway API error" });
  }
});

// ------------- TripShot PARSER (RIDES-ONLY) -------------

function parseTripShotCommutePlanForOrigin(json, originStopId, originLabel) {
  const routes = json.routes || [];
  const rides = json.rides || [];

  // routeId → info
  const routeInfoById = {};
  for (const r of routes) {
    const id = r.routeId;
    if (!id) continue;
    const name = r.name || r.shortName || "Shuttle";
    const shortName = r.shortName || name;

    let colorLabel = "";
    if (/green/i.test(name) || /green/i.test(shortName)) colorLabel = "Green";
    else if (/red/i.test(name) || /red/i.test(shortName)) colorLabel = "Red";
    else if (/blue/i.test(name) || /blue/i.test(shortName)) colorLabel = "Blue";

    routeInfoById[id] = { id, name, shortName, colorLabel };
  }

  const originIdLower = originStopId.toLowerCase();
  const ninetySixIdLower = NINETY_SIX_STOP_ID.toLowerCase();

  const result = {
    stopName: originLabel,
    green: [],
    red: [],
    blue: []
  };

  const buckets = { green: [], red: [], blue: [] };

  const isWalkingRide = (ride) => {
    const mode = (ride.mode || ride.type || "").toString().toLowerCase();
    return mode.includes("walk");
  };

  function considerRide(ride, routeInfo) {
    if (!ride || !routeInfo) return;

    // Exclude Manhattanville campus shuttles entirely
    const rName = (routeInfo.name || "").toLowerCase();
    const rShort = (routeInfo.shortName || "").toLowerCase();
    if (rName.includes("manhattanville") || rName.includes("m'ville") || rName.includes("mville") ||
        rShort.includes("manhattanville") || rShort.includes("m'ville") || rShort.includes("mville")) {
      return;
    }

    const statuses = ride.stopStatus || [];
    let originNode = null;
    let ninetySixNode = null;

    for (const wrapper of statuses) {
      if (!wrapper) continue;
      const keys = Object.keys(wrapper);
      let inner = wrapper;
      if (keys.length === 1 && typeof wrapper[keys[0]] === "object") {
        inner = wrapper[keys[0]];
      }
      const sid = (inner.stopId || "").toLowerCase();
      if (sid === originIdLower) {
        originNode = inner;
      }
      if (sid === ninetySixIdLower) {
        ninetySixNode = inner;
      }
    }

    // Only keep rides that actually have our origin stop
    if (!originNode) return;

    const scheduledTime =
      originNode.scheduledDepartureTime ||
      originNode.scheduledArrivalTime ||
      originNode.scheduledAt;

    const liveTime =
      originNode.expectedArrivalTime ||
      originNode.expectedDepartureTime ||
      scheduledTime;

    if (!liveTime) return;

    // Determine if this ride actually reaches 96th after origin
    let reaches96 = false;
    if (ninetySixNode) {
      const ninetySixTime =
        ninetySixNode.expectedArrivalTime ||
        ninetySixNode.scheduledArrivalTime ||
        ninetySixNode.scheduledAt;
      if (ninetySixTime) {
        const originMs = new Date(liveTime).getTime();
        const ninetySixMs = new Date(ninetySixTime).getTime();
        if (originMs < ninetySixMs) {
          reaches96 = true;
        }
      }
    }

    // Color bucketing
    let colorKey = "blue";
    if (routeInfo.colorLabel) {
      colorKey = routeInfo.colorLabel.toLowerCase();
    } else if (/green/i.test(routeInfo.name) || /green/i.test(routeInfo.shortName)) {
      colorKey = "green";
    } else if (/red/i.test(routeInfo.name) || /red/i.test(routeInfo.shortName)) {
      colorKey = "red";
    } else if (/blue/i.test(routeInfo.name) || /blue/i.test(routeInfo.shortName)) {
      colorKey = "blue";
    }
    if (!["green", "red", "blue"].includes(colorKey)) {
      colorKey = "blue";
    }

    const liveDate = new Date(liveTime);
    const entry = {
      routeName: routeInfo.name,
      color: routeInfo.colorLabel || colorKey[0].toUpperCase() + colorKey.slice(1),
      time: formatTime(liveTime),
      rawISO: liveTime,
      inMinutes: minutesFromNow(liveTime),
      direct: reaches96,
      delayed: false
    };

    if (scheduledTime) {
      const delayMin =
        (liveDate.getTime() - new Date(scheduledTime).getTime()) / 60000;
      if (delayMin > 1) {
        entry.delayed = true;
      }
    }

    buckets[colorKey].push(entry);
  }

  for (const ride of rides) {
    if (isWalkingRide(ride)) continue; // ignore walking segments entirely

    const routeInfo =
      routeInfoById[ride.routeId] ||
      routeInfoById[ride.routeServiceId] || {
        id: ride.routeId || ride.routeServiceId,
        name: "Shuttle",
        shortName: "Shuttle",
        colorLabel: ""
      };

    considerRide(ride, routeInfo);
  }

  // Sort each color's list and keep first 3
  for (const key of ["green", "red", "blue"]) {
    const arr = buckets[key];
    arr.sort((a, b) => new Date(a.rawISO) - new Date(b.rawISO));
    result[key] = arr.slice(0, 3);
  }

  return result;
}

// ------------- SHUTTLE API -------------

app.get("/api/shuttle", async (req, res) => {
  try {
    const payloadEC = buildTripShotPayload("EC S", EC_S_LOCATION, EC_S_STOP_ID);
    const payload120 = buildTripShotPayload("120 S", S120_LOCATION, S120_STOP_ID);

    const [respEC, resp120] = await Promise.all([
      fetch(TRIPSHOT_COMMUTE_PLAN_URL, {
        method: "POST",
        headers: TRIPSHOT_HEADERS,
        body: JSON.stringify(payloadEC)
      }),
      fetch(TRIPSHOT_COMMUTE_PLAN_URL, {
        method: "POST",
        headers: TRIPSHOT_HEADERS,
        body: JSON.stringify(payload120)
      })
    ]);

    if (!respEC.ok || !resp120.ok) {
      console.error("TripShot HTTP", respEC.status, resp120.status);
      return res.status(500).json({ error: "TripShot request failed" });
    }

    const [dataEC, data120] = await Promise.all([respEC.json(), resp120.json()]);

    const parsedEC = parseTripShotCommutePlanForOrigin(
      dataEC,
      EC_S_STOP_ID,
      "EC S"
    );
    const parsed120 = parseTripShotCommutePlanForOrigin(
      data120,
      S120_STOP_ID,
      "120 S"
    );

    res.json({ ecS: parsedEC, s120: parsed120 });
  } catch (err) {
    console.error("Shuttle API error", err);
    res.status(500).json({ error: "Shuttle API error" });
  }
});

// ------------- STATIC FRONTEND -------------

app.use(express.static(publicDir));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
