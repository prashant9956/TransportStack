const fs = require("fs");
const csv = require("csv-parser");

const baselinePath = "data/analytics/october-2026-route-hourly-baseline.json";
const gtfsPath = "data/gtfs/delhi_buses_static_gtfs_v1/routes.txt";

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const historicalIds = new Set(Object.keys(baseline.routes));
const staticRoutes = new Map();

fs.createReadStream(gtfsPath)
    .pipe(csv())
    .on("data", row => {
        staticRoutes.set(String(row.route_id).trim(), {
            routeId: String(row.route_id).trim(),
            shortName: row.route_short_name,
            longName: row.route_long_name,
            agencyId: row.agency_id
        });
    })
    .on("end", () => {
        const matched = [];
        const unmatched = [];

        for (const id of historicalIds) {
            if (staticRoutes.has(id)) {
                matched.push({
                    ...staticRoutes.get(id),
                    historicalSpeed: baseline.routes[id].averageSpeedKmh,
                    historicalRecords: baseline.routes[id].totalRecords
                });
            } else {
                unmatched.push(id);
            }
        }

        const result = {
            staticRouteCount: staticRoutes.size,
            historicalRouteCount: historicalIds.size,
            matchedRouteCount: matched.length,
            unmatchedRouteCount: unmatched.length,
            matchPercentage: Number(
                (matched.length / historicalIds.size * 100).toFixed(2)
            ),
            matchedSample: matched.slice(0, 15),
            unmatchedSample: unmatched.slice(0, 15)
        };

        fs.writeFileSync(
            "data/analytics/gtfs-historical-validation.json",
            JSON.stringify(result, null, 2)
        );

        console.log("\n========== GTFS VALIDATION ==========");
        console.log("Static GTFS routes:", result.staticRouteCount);
        console.log("Historical routes:", result.historicalRouteCount);
        console.log("Matched:", result.matchedRouteCount);
        console.log("Unmatched:", result.unmatchedRouteCount);
        console.log("Match:", result.matchPercentage + "%");

        console.log("\n========== MATCHED SAMPLE ==========");
        console.table(matched.slice(0, 10));

        console.log("\nSaved: data/analytics/gtfs-historical-validation.json");
    })
    .on("error", error => {
        console.error("GTFS validation failed:", error.message);
        process.exitCode = 1;
    });
