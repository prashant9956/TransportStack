const fs = require("fs");
const csv = require("csv-parser");

const baseline = JSON.parse(
    fs.readFileSync(
        "data/analytics/october-2026-route-hourly-baseline.json",
        "utf8"
    )
);

const validation = JSON.parse(
    fs.readFileSync(
        "data/analytics/gtfs-historical-validation.json",
        "utf8"
    )
);

const tripsPath = "data/gtfs/delhi_buses_static_gtfs_v1/trips.txt";

const historicalIds = new Set(Object.keys(baseline.routes));
const matchedIds = new Set(
    validation.matchedSample.map(item => item.routeId)
);

// Use all static routes, not only the 15-row validation sample.
const routeMap = new Map();
const trips = [];

fs.createReadStream(tripsPath)
    .pipe(csv())
    .on("data", row => {
        const routeId = String(row.route_id || "").trim();

        if (!historicalIds.has(routeId)) return;

        if (!routeMap.has(routeId)) {
            routeMap.set(routeId, {
                routeId,
                tripCount: 0,
                shapes: {},
                directions: {}
            });
        }

        const item = routeMap.get(routeId);
        const shapeId = String(row.shape_id || "").trim();
        const directionId = String(row.direction_id ?? "unknown");

        item.tripCount++;

        if (shapeId) {
            item.shapes[shapeId] = (item.shapes[shapeId] || 0) + 1;
        }

        item.directions[directionId] =
            (item.directions[directionId] || 0) + 1;
    })
    .on("end", () => {
        const results = [];

        for (const [routeId, item] of routeMap) {
            const historical = baseline.routes[routeId];

            results.push({
                ...item,
                historicalAverageSpeedKmh: historical.averageSpeedKmh,
                historicalRecords: historical.totalRecords,
                shapeCount: Object.keys(item.shapes).length
            });
        }

        const output = {
            generatedAt: new Date().toISOString(),
            historicalRouteCount: historicalIds.size,
            routesWithTrips: results.length,
            routesWithoutTrips: historicalIds.size - results.length,
            routeMappings: results
        };

        fs.writeFileSync(
            "data/analytics/historical-trip-shape-mapping.json",
            JSON.stringify(output)
        );

        console.log("\n========== TRIP / SHAPE MAPPING ==========");
        console.log("Historical routes:", historicalIds.size);
        console.log("Routes with GTFS trips:", results.length);
        console.log(
            "Routes without trips:",
            output.routesWithoutTrips
        );

        console.log("\n========== ROUTES 1064 / 1065 ==========");

        console.log(
            JSON.stringify(
                results.filter(r => ["1064", "1065"].includes(r.routeId)),
                null,
                2
            )
        );

        console.log(
            "\nSaved: data/analytics/historical-trip-shape-mapping.json"
        );
    })
    .on("error", error => {
        console.error(error);
        process.exitCode = 1;
    });
