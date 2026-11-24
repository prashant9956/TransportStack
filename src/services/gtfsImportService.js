
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const Agency = require("../models/agency");
const Route = require("../models/route");
const Stop = require("../models/stop");
const Trip = require("../models/trip");
const StopTime = require("../models/stopTime");
const Service = require("../models/service");
const ServiceException = require("../models/serviceException");

const BATCH_SIZE = 500;
const DEBUG_TRIP_ID = "2583_FULL_00_00";

function parseOptionalInteger(value) {
    if (
        value === undefined ||
        value === null ||
        String(value).trim() === ""
    ) {
        return null;
    }

    const parsed = Number(value);

    return Number.isInteger(parsed) ? parsed : null;
}

function parseGTFSDate(value) {
    const date = String(value || "").trim();

    if (!/^\d{8}$/.test(date)) return null;

    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6));
    const day = Number(date.slice(6, 8));

    const parsed = new Date(Date.UTC(year, month - 1, day));

    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day
    ) {
        return null;
    }

    return date;
}

function findEntry(directory, filename) {
    return directory.files.find(entry => {
        return (
            path.basename(entry.path).toLowerCase() ===
                filename.toLowerCase() &&
            entry.type !== "Directory"
        );
    });
}

async function processCSV(entry, Model, mapper, filterMapper, label) {
    let batch = [];
    let processed = 0;
    let rejected = 0;
    let errors = 0;
    let rowNumber = 0;

    const stream = entry.stream().pipe(csv());

    for await (const row of stream) {
        rowNumber++;

        let document;

        try {
            document = mapper(row);
        } catch (error) {
            rejected++;
            console.error(`${label} mapper error:`, error.message);
            continue;
        }

        if (!document) {
            rejected++;

            if (row.trip_id === DEBUG_TRIP_ID) {
                console.log("DEBUG ROW REJECTED:", row);
            }

            continue;
        }

        if (row.trip_id === DEBUG_TRIP_ID) {
            console.log("DEBUG ROW ACCEPTED:", document);
        }

        batch.push({
            updateOne: {
                filter: filterMapper(document),
                update: { $set: document },
                upsert: true
            }
        });

        if (batch.length >= BATCH_SIZE) {
            try {
                const result = await Model.bulkWrite(batch, {
                    ordered: false
                });

                processed += batch.length;

                console.log(`${label} batch saved:`, {
                    batchSize: batch.length,
                    upserted: result.upsertedCount,
                    modified: result.modifiedCount
                });
            } catch (error) {
                errors += batch.length;
                console.error(`${label} bulk write error:`, error.message);
            }

            batch = [];
        }
    }

    if (batch.length > 0) {
        try {
            const result = await Model.bulkWrite(batch, {
                ordered: false
            });

            processed += batch.length;

            console.log(`${label} final batch saved:`, {
                batchSize: batch.length,
                upserted: result.upsertedCount,
                modified: result.modifiedCount
            });
        } catch (error) {
            errors += batch.length;
            console.error(`${label} final write error:`, error.message);
        }
    }

    const summary = {
        processed,
        rejected,
        errors,
        totalRows: rowNumber
    };

    console.log(`${label} import summary:`, summary);

    return summary;
}

async function importGTFS(folderPath) {
    const absolutePath = path.resolve(folderPath);

    const stats = await fs.promises.stat(absolutePath);

    if (!stats.isDirectory()) {
        throw new Error("GTFS path must be an extracted folder.");
    }

    const filenames = await fs.promises.readdir(absolutePath);

    const directory = {
        files: filenames.map(filename => {
            const fullPath = path.join(absolutePath, filename);

            return {
                path: filename,
                type: "File",
                stream: () => fs.createReadStream(fullPath)
            };
        })
    };

    const requiredFiles = [
        "agency.txt",
        "routes.txt",
        "stops.txt",
        "trips.txt",
        "stop_times.txt",
        "calendar.txt"
    ];

    const entries = {};

    for (const filename of requiredFiles) {
        entries[filename] = findEntry(directory, filename);

        if (!entries[filename]) {
            throw new Error(`Missing GTFS file: ${filename}`);
        }
    }

    entries["calendar_dates.txt"] = findEntry(
        directory,
        "calendar_dates.txt"
    );

    const result = {};

    // 1. Agencies
    result.agencies = await processCSV(
        entries["agency.txt"],
        Agency,
        row => {
            if (!row.agency_name) return null;

            return {
                agencyId: row.agency_id || "default",
                agencyName: row.agency_name,
                agencyUrl: row.agency_url || "",
                agencyTimezone: row.agency_timezone || "",
                agencyPhone: row.agency_phone || ""
            };
        },
        doc => ({ agencyId: doc.agencyId }),
        "agency"
    );

    // 2. Routes
    result.routes = await processCSV(
        entries["routes.txt"],
        Route,
        row => {
            if (!row.route_id) return null;

            return {
                routeId: row.route_id,
                agencyId: row.agency_id || null,
                routeShortName: row.route_short_name || "",
                routeLongName: row.route_long_name || "",
                routeType: parseOptionalInteger(row.route_type),
                routeColor: row.route_color || "",
                routeTextColor: row.route_text_color || ""
            };
        },
        doc => ({ routeId: doc.routeId }),
        "routes"
    );

    // 3. Stops
    result.stops = await processCSV(
        entries["stops.txt"],
        Stop,
        row => {
            const lat = Number(row.stop_lat);
            const lon = Number(row.stop_lon);

            if (
                !row.stop_id ||
                !row.stop_name ||
                !Number.isFinite(lat) ||
                !Number.isFinite(lon)
            ) {
                return null;
            }

            return {
                stopId: row.stop_id,
                stopName: row.stop_name,
                stopLat: lat,
                stopLon: lon,
                locationType: parseOptionalInteger(row.location_type),
                parentStation: row.parent_station || ""
            };
        },
        doc => ({ stopId: doc.stopId }),
        "stops"
    );

    // 4. Service Calendar
    result.services = await processCSV(
        entries["calendar.txt"],
        Service,
        row => {
            if (!row.service_id) return null;

            const startDate = parseGTFSDate(row.start_date);
            const endDate = parseGTFSDate(row.end_date);

            if (!startDate || !endDate || startDate > endDate) {
                return null;
            }

            const days = [
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday"
            ];

            const document = {
                serviceId: row.service_id,
                startDate,
                endDate
            };

            for (const day of days) {
                if (row[day] !== "0" && row[day] !== "1") {
                    return null;
                }

                document[day] = row[day] === "1";
            }

            return document;
        },
        doc => ({ serviceId: doc.serviceId }),
        "calendar"
    );

    // 5. Optional Calendar Exceptions
    if (entries["calendar_dates.txt"]) {
        result.serviceExceptions = await processCSV(
            entries["calendar_dates.txt"],
            ServiceException,
            row => {
                if (!row.service_id) return null;

                const exceptionDate = parseGTFSDate(row.date);
                const exceptionType = parseOptionalInteger(
                    row.exception_type
                );

                if (
                    !exceptionDate ||
                    ![1, 2].includes(exceptionType)
                ) {
                    return null;
                }

                return {
                    serviceId: row.service_id,
                    exceptionDate,
                    exceptionType
                };
            },
            doc => ({
                serviceId: doc.serviceId,
                exceptionDate: doc.exceptionDate
            }),
            "calendar_dates"
        );
    } else {
        result.serviceExceptions = {
            processed: 0,
            rejected: 0,
            errors: 0,
            totalRows: 0,
            message: "calendar_dates.txt not present; skipped"
        };

        console.log(result.serviceExceptions.message);
    }

    // 6. Trips
    result.trips = await processCSV(
        entries["trips.txt"],
        Trip,
        row => {
            if (!row.trip_id || !row.route_id) return null;

            return {
                tripId: row.trip_id,
                routeId: row.route_id,
                serviceId: row.service_id || "",
                tripHeadsign: row.trip_headsign || "",
                directionId: parseOptionalInteger(row.direction_id),
                shapeId: row.shape_id || ""
            };
        },
        doc => ({ tripId: doc.tripId }),
        "trips"
    );

    // 7. Stop Times
    result.stopTimes = await processCSV(
        entries["stop_times.txt"],
        StopTime,
        row => {
            const sequence = Number(row.stop_sequence);

            if (
                !row.trip_id ||
                !row.stop_id ||
                !Number.isFinite(sequence)
            ) {
                return null;
            }

            return {
                tripId: row.trip_id,
                arrivalTime: row.arrival_time || "",
                departureTime: row.departure_time || "",
                stopId: row.stop_id,
                stopSequence: sequence
            };
        },
        doc => ({
            tripId: doc.tripId,
            stopSequence: doc.stopSequence
        }),
        "stop_times"
    );

    console.log("GTFS IMPORT COMPLETED:", result);

    return result;
}

module.exports = importGTFS;
