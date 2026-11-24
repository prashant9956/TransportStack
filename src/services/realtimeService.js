
const axios = require("axios");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");
const VehicleHistory = require("../models/vehicleHistory");

// In-memory positions are retained for immediate speed calculation.
const previousPositions = new Map();

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = degree => degree * Math.PI / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function readLong(value) {
    if (value === null || value === undefined) return null;

    const number = typeof value.toNumber === "function"
        ? value.toNumber()
        : Number(value);

    return Number.isFinite(number) ? number : null;
}

async function saveVehicleHistory(vehicles) {
    const operations = vehicles
        .filter(vehicle => {
            if (!vehicle.vehicleId || !vehicle.timestamp) return false;

            if (
                !Number.isFinite(vehicle.latitude) ||
                !Number.isFinite(vehicle.longitude)
            ) {
                return false;
            }

            if (
                vehicle.latitude < -90 ||
                vehicle.latitude > 90 ||
                vehicle.longitude < -180 ||
                vehicle.longitude > 180
            ) {
                return false;
            }

            return !vehicle.isStale;
        })
        .map(vehicle => ({
            updateOne: {
                filter: {
                    vehicleId: vehicle.vehicleId,
                    timestamp: new Date(vehicle.timestamp)
                },
                update: {
                    $setOnInsert: {
                        vehicleId: vehicle.vehicleId,
                        routeId: vehicle.routeId,
                        tripId: vehicle.tripId,
                        latitude: vehicle.latitude,
                        longitude: vehicle.longitude,
                        speed: vehicle.speed,
                        speedSource: vehicle.speedSource,
                        bearing: vehicle.bearing,
                        timestamp: new Date(vehicle.timestamp)
                    }
                },
                upsert: true
            }
        }));

    if (operations.length === 0) {
        return 0;
    }

    try {
        const result = await VehicleHistory.bulkWrite(
            operations,
            { ordered: false }
        );

        const savedCount =
            (result.upsertedCount || 0) +
            (result.modifiedCount || 0);

        console.log(
            "GPS history:",
            savedCount,
            "new observations saved;",
            operations.length,
            "vehicles processed"
        );

        return savedCount;
    } catch (error) {
        // Duplicate-key errors can occur if two feed requests overlap.
        // Other database errors are surfaced instead of silently ignored.
        if (error.code === 11000 || error.writeErrors?.length) {
            console.error(
                "GPS history bulk-write warning:",
                error.message
            );
            return 0;
        }

        throw error;
    }
}

async function getLiveVehicles() {
    const apiKey = process.env.OTD_API_KEY;

    if (!apiKey) {
        throw new Error("OTD_API_KEY missing in .env");
    }

    const url =
        `https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key=${encodeURIComponent(apiKey)}`;

    try {
        console.log("Fetching OTD live vehicle feed...");

        const response = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 60000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        const feed =
            GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
                new Uint8Array(response.data)
            );

        const now = Date.now();

        const vehicles = feed.entity
            .filter(entity => entity.vehicle?.position)
            .map(entity => {
                const vehicle = entity.vehicle;
                const position = vehicle.position;
                const trip = vehicle.trip || {};

                const vehicleId = vehicle.vehicle?.id || null;
                const latitude = Number(position.latitude);
                const longitude = Number(position.longitude);

                const rawTimestamp = readLong(vehicle.timestamp);

                const timestamp = rawTimestamp === null
                    ? null
                    : rawTimestamp * 1000;

                const timestampIsUsable =
                    timestamp !== null &&
                    now - timestamp <= 60000 &&
                    timestamp - now <= 30000;

                let speed = null;
                let calculatedSpeed = null;
                let speedSource = "unavailable";

                if (vehicleId && timestampIsUsable) {
                    const previous = previousPositions.get(vehicleId);

                    if (previous && timestamp > previous.timestamp) {
                        const distance = calculateDistance(
                            previous.latitude,
                            previous.longitude,
                            latitude,
                            longitude
                        );

                        const elapsedSeconds =
                            (timestamp - previous.timestamp) / 1000;

                        if (elapsedSeconds >= 5 && elapsedSeconds <= 120) {
                            const gpsSpeed =
                                (distance / elapsedSeconds) * 3.6;

                            if (
                                Number.isFinite(gpsSpeed) &&
                                gpsSpeed <= 100
                            ) {
                                calculatedSpeed =
                                    Number(gpsSpeed.toFixed(1));
                            }
                        }
                    }

                    if (!previous || timestamp > previous.timestamp) {
                        previousPositions.set(vehicleId, {
                            latitude,
                            longitude,
                            timestamp
                        });
                    }
                }

                const feedSpeed = Number(position.speed);

                if (
                    timestampIsUsable &&
                    position.speed !== null &&
                    position.speed !== undefined &&
                    Number.isFinite(feedSpeed) &&
                    feedSpeed > 0
                ) {
                    speed = Number((feedSpeed * 3.6).toFixed(1));
                    speedSource = "feed";
                } else if (
                    timestampIsUsable &&
                    calculatedSpeed !== null
                ) {
                    speed = calculatedSpeed;
                    speedSource = "gps-calculated";
                }

                const rawDirectionId = trip.directionId;

                const directionId =
                    rawDirectionId === null ||
                    rawDirectionId === undefined
                        ? null
                        : Number(rawDirectionId);

                return {
                    vehicleId,
                    tripId: trip.tripId || null,
                    routeId: trip.routeId || null,

                    directionId: Number.isFinite(directionId)
                        ? directionId
                        : null,

                    tripStartDate: trip.startDate || null,
                    tripStartTime: trip.startTime || null,

                    scheduleRelationship:
                        trip.scheduleRelationship ?? null,

                    latitude,
                    longitude,
                    speed,
                    speedSource,
                    bearing: position.bearing ?? null,
                    stopId: vehicle.stopId || null,

                    timestamp: timestamp !== null
                        ? new Date(timestamp).toISOString()
                        : null,

                    isStale: !timestampIsUsable
                };
            });

        // Persist valid live observations before returning the feed.
        await saveVehicleHistory(vehicles);

        // Remove old in-memory positions to prevent unlimited growth.
        for (const [vehicleId, previous] of previousPositions.entries()) {
            if (now - previous.timestamp > 10 * 60 * 1000) {
                previousPositions.delete(vehicleId);
            }
        }

        console.log("OTD HTTP Status:", response.status);
        console.log("Decoded vehicles:", vehicles.length);

        console.log(
            "Vehicles with direction ID:",
            vehicles.filter(vehicle =>
                vehicle.directionId !== null
            ).length
        );

        console.log(
            "Stale vehicles:",
            vehicles.filter(vehicle => vehicle.isStale).length
        );

        return {
            totalVehicles: vehicles.length,
            vehicles
        };

    } catch (error) {
        console.error("OTD FETCH ERROR:", error.message);
        console.error("OTD ERROR CODE:", error.code);

        console.error(
            "OTD RESPONSE STATUS:",
            error.response?.status || "No response"
        );

        throw error;
    }
}

module.exports = {
    getLiveVehicles,
    saveVehicleHistory
};
