const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH =
    "C:/TransportStackData/extracted/bus_movements_2026_10_01.db";

const OUTPUT_PATH =
    path.join(process.cwd(), "data/analytics/october-2026-route-hourly-baseline.json");

if (!fs.existsSync(DB_PATH)) {
    throw new Error("SQLite database not found: " + DB_PATH);
}

console.log("Opening October historical database...");

const db = new DatabaseSync(DB_PATH, { readOnly: true });

try {
    console.log("Scanning GPS records and calculating hourly route statistics...");

    const sql = `
        SELECT
            CAST(route_id AS INTEGER) AS routeId,
            CAST(
                strftime(
                    '%H',
                    CAST(timestamp AS INTEGER),
                    'unixepoch',
                    '+5 hours',
                    '+30 minutes'
                ) AS INTEGER
            ) AS localHour,
            COUNT(*) AS recordCount,
            COUNT(DISTINCT vehicle_id) AS vehicleCount,
            ROUND(AVG(speed), 2) AS averageSpeedKmh,
            ROUND(MIN(speed), 2) AS minimumSpeedKmh,
            ROUND(MAX(speed), 2) AS maximumSpeedKmh
        FROM vehicle_feed
        WHERE
            route_id IS NOT NULL
            AND vehicle_id IS NOT NULL
            AND CAST(timestamp AS INTEGER) > 0
            AND speed > 1
            AND speed <= 55
            AND CAST(lat AS REAL) BETWEEN 27 AND 30
            AND CAST(lng AS REAL) BETWEEN 76 AND 78
        GROUP BY routeId, localHour
        ORDER BY routeId, localHour
    `;

    const rows = db.prepare(sql).all();

    console.log("Aggregated groups:", rows.length);

    const routes = {};

    for (const row of rows) {
        const routeId = String(row.routeId);

        if (!routes[routeId]) {
            routes[routeId] = {
                routeId,
                hourly: {},
                totalRecords: 0,
                totalVehicles: 0,
                weightedSpeed: 0
            };
        }

        const route = routes[routeId];

        route.hourly[row.localHour] = {
            hour: row.localHour,
            averageSpeedKmh: row.averageSpeedKmh,
            minimumSpeedKmh: row.minimumSpeedKmh,
            maximumSpeedKmh: row.maximumSpeedKmh,
            recordCount: row.recordCount,
            vehicleCount: row.vehicleCount
        };

        route.totalRecords += row.recordCount;
        route.totalVehicles += row.vehicleCount;
        route.weightedSpeed +=
            row.averageSpeedKmh * row.recordCount;
    }

    for (const route of Object.values(routes)) {
        route.averageSpeedKmh = Number(
            (route.weightedSpeed / route.totalRecords).toFixed(2)
        );

        delete route.weightedSpeed;
    }

    const output = {
        metadata: {
            source: "Delhi DTC GTFS-RT Historical Archive",
            archiveDate: "2026-10-01",
            timezone: "Asia/Kolkata",
            generatedAt: new Date().toISOString(),
            speedUnit: "km/h",
            filtering: {
                minimumSpeedKmh: 1,
                maximumSpeedKmh: 55,
                latitudeRange: [27, 30],
                longitudeRange: [76, 78]
            },
            aggregation: "route_id + local hour"
        },
        summary: {
            totalRoutes: Object.keys(routes).length,
            totalHourlyGroups: rows.length
        },
        routes
    };

    fs.writeFileSync(
        OUTPUT_PATH,
        JSON.stringify(output),
        "utf8"
    );

    console.log("\n========== PROCESSING COMPLETE ==========");
    console.log("Routes:", output.summary.totalRoutes);
    console.log("Hourly groups:", output.summary.totalHourlyGroups);
    console.log("Output:", OUTPUT_PATH);

    console.log("\n========== SAMPLE ROUTES ==========");

    console.log(
        Object.values(routes).slice(0, 5).map(route => ({
            routeId: route.routeId,
            averageSpeedKmh: route.averageSpeedKmh,
            totalRecords: route.totalRecords,
            hoursAvailable: Object.keys(route.hourly).length
        }))
    );

} finally {
    db.close();
}
