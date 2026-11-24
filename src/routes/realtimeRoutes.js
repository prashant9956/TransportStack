
const express = require("express");
const router = express.Router();


const fs = require("fs");
const path = require("path");

const historicalBaselinePath = path.join(
    __dirname,
    "../../data/analytics/october-2026-route-hourly-baseline.json"
);

let routeHourlyBaseline = {};

try {
    const baselineData = JSON.parse(
        fs.readFileSync(historicalBaselinePath, "utf8")
    );

    routeHourlyBaseline = baselineData.routes || {};
    console.log(
        `Historical route-hourly baseline loaded: ${Object.keys(routeHourlyBaseline).length} routes`
    );
} catch (error) {
    console.warn(
        "Historical route-hourly baseline unavailable:",
        error.message
    );
}






const { getLiveVehicles } = require("../services/realtimeService");

const Trip = require("../models/trip");
const Shape = require("../models/shape");
const StopTime = require("../models/stopTime");
const Stop = require("../models/stop");
const VehicleHistory = require("../models/vehicleHistory");
const Route = require("../models/route");

const MAX_ROUTE_DISTANCE = 150;
const PASSED_STOP_TOLERANCE = 25;

const DIAGNOSTIC_RADIUS_METRES = 2500;
const MAX_ALTERNATIVE_CANDIDATES = 5;

const MAX_DISAMBIGUATION_TRIPS = 50;
const MAX_DISAMBIGUATION_STOP_TIMES = 5000;
const MAX_SEQUENCE_LENGTH = 250;

const HISTORY_WINDOW_MINUTES = 30;
const HISTORY_POINT_LIMIT = 10;
const MIN_HISTORY_INTERVAL_SECONDS = 5;
const MAX_HISTORY_INTERVAL_SECONDS = 600;
const MIN_VALID_SPEED_KMH = 2;
const MAX_VALID_SPEED_KMH = 100;
const MIN_VALID_SPEED_SAMPLES = 2;

const MIN_TEMPORAL_OBSERVATIONS = 3;
const MAX_TEMPORAL_DISTANCE_METRES = 150;
const MIN_TEMPORAL_MOVEMENT_METRES = 20;
const MAX_TEMPORAL_MOVEMENT_METRES = 10000;
const MIN_DIRECTION_CONSISTENCY = 0.65;

// ETA reliability
const MAX_FUTURE_GPS_SECONDS = 30;
const MAX_HISTORY_AGE_SECONDS = HISTORY_WINDOW_MINUTES * 60;
const MIN_HISTORICAL_ETA_CONFIDENCE = "medium";


//**get current ist hour */
function getCurrentISTHour() {
    return Number(
        new Intl.DateTimeFormat("en-IN", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            hourCycle: "h23"
        }).format(new Date())
    );
}
function getCurrentISTHour() {
    return Number(
        new Intl.DateTimeFormat("en-IN", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            hourCycle: "h23"
        }).format(new Date())
    );
}

// YAHAN STEP 3 PASTE KARO
function getRouteHourlyBaseline(routeId) {
    const routeData = routeHourlyBaseline[String(routeId)];

    if (!routeData) return null;

    const hour = getCurrentISTHour();
    const hourlyData = routeData.hourly?.[String(hour)];

    if (!hourlyData) return null;

    if (
        Number(hourlyData.vehicleCount) < 3 ||
        Number(hourlyData.recordCount) < 100 ||
        !Number.isFinite(Number(hourlyData.averageSpeedKmh)) ||
        Number(hourlyData.averageSpeedKmh) <= MIN_VALID_SPEED_KMH ||
        Number(hourlyData.averageSpeedKmh) > MAX_VALID_SPEED_KMH
    ) {
        return null;
    }

    return {
        speedKmh: Number(hourlyData.averageSpeedKmh),
        confidence: "low",
        sampleCount: Number(hourlyData.recordCount),
        vehicleCount: Number(hourlyData.vehicleCount),
        hour
    };
}
// --------------------------------------------------
// DISTANCE AND BASIC HELPERS
// --------------------------------------------------

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = value => value * Math.PI / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return 2 * R * Math.atan2(
        Math.sqrt(a),
        Math.sqrt(1 - a)
    );
}

function getMedian(values) {
    if (!values.length) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isValidCoordinate(latitude, longitude) {
    const lat = Number(latitude);
    const lon = Number(longitude);

    return (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= -90 &&
        lat <= 90 &&
        lon >= -180 &&
        lon <= 180
    );
}

// --------------------------------------------------
// GPS FRESHNESS
// --------------------------------------------------

function addVehicleStatus(vehicle) {
    const now = Date.now();

    const timestamp = vehicle.timestamp
        ? new Date(vehicle.timestamp).getTime()
        : NaN;

    const validTimestamp =
        Number.isFinite(timestamp) &&
        timestamp <= now + MAX_FUTURE_GPS_SECONDS * 1000;

    const ageSeconds = validTimestamp
        ? Math.max(0, Math.floor((now - timestamp) / 1000))
        : null;

    let dataStatus;
    let isStale;

    if (!validTimestamp) {
        dataStatus = "unknown";
        isStale = true;
    } else if (ageSeconds <= 30) {
        dataStatus = "live";
        isStale = false;
    } else if (ageSeconds <= 60) {
        dataStatus = "delayed";
        isStale = false;
    } else {
        dataStatus = "stale";
        isStale = true;
    }

    return {
        ...vehicle,
        dataAgeSeconds: ageSeconds,
        dataStatus,
        isStale,
        speed: isStale ? null : vehicle.speed,
        speedSource: isStale
            ? "unavailable"
            : vehicle.speedSource
    };
}

// --------------------------------------------------
// BUILD ROUTE GEOMETRY
// --------------------------------------------------

function buildRouteGeometry(shapePoints) {
    const points = shapePoints
        .filter(point =>
            Number.isFinite(Number(point.shapePtLat)) &&
            Number.isFinite(Number(point.shapePtLon))
        )
        .sort((a, b) =>
            Number(a.shapePtSequence) - Number(b.shapePtSequence)
        );

    if (points.length < 2) return null;

    const cumulativeDistances = [0];

    for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1];
        const current = points[i];

        const distance = getDistance(
            Number(previous.shapePtLat),
            Number(previous.shapePtLon),
            Number(current.shapePtLat),
            Number(current.shapePtLon)
        );

        cumulativeDistances.push(
            cumulativeDistances[i - 1] + distance
        );
    }

    return {
        points,
        cumulativeDistances,
        totalDistance: cumulativeDistances[
            cumulativeDistances.length - 1
        ]
    };
}

// --------------------------------------------------
// PROJECT GPS POINT ONTO GTFS SHAPE
// --------------------------------------------------

function projectPointOntoRoute(lat, lon, geometry) {
    if (!geometry || geometry.points.length < 2) return null;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
    }

    const points = geometry.points;
    const distances = geometry.cumulativeDistances;

    const metersPerDegree = 111320;
    const longitudeScale = Math.cos(lat * Math.PI / 180);

    let bestProjection = null;
    let minimumDistance = Infinity;

    for (let i = 0; i < points.length - 1; i++) {
        const start = points[i];
        const end = points[i + 1];

        const x1 =
            (Number(start.shapePtLon) - lon) *
            metersPerDegree * longitudeScale;

        const y1 =
            (Number(start.shapePtLat) - lat) * 110540;

        const x2 =
            (Number(end.shapePtLon) - lon) *
            metersPerDegree * longitudeScale;

        const y2 =
            (Number(end.shapePtLat) - lat) * 110540;

        const dx = x2 - x1;
        const dy = y2 - y1;

        const segmentLengthSquared = dx * dx + dy * dy;

        if (segmentLengthSquared === 0) continue;

        let t =
            -(x1 * dx + y1 * dy) /
            segmentLengthSquared;

        t = Math.max(0, Math.min(1, t));

        const projectedX = x1 + t * dx;
        const projectedY = y1 + t * dy;

        const distance = Math.sqrt(
            projectedX ** 2 + projectedY ** 2
        );

        if (distance < minimumDistance) {
            minimumDistance = distance;

            const segmentDistance =
                distances[i + 1] - distances[i];

            bestProjection = {
                alongDistance:
                    distances[i] + t * segmentDistance,
                distanceFromRoute: distance,
                segmentIndex: i
            };
        }
    }

    return bestProjection;
}

// --------------------------------------------------
// LOAD RECENT GPS HISTORY
// --------------------------------------------------

async function getRecentVehicleHistory(vehicles) {
    const vehicleIds = [
        ...new Set(
            vehicles
                .map(vehicle => vehicle.vehicleId)
                .filter(Boolean)
                .map(String)
        )
    ];

    if (!vehicleIds.length) return new Map();

    const now = Date.now();

    const cutoff = new Date(
        now - HISTORY_WINDOW_MINUTES * 60 * 1000
    );

    const futureLimit = new Date(
        now + MAX_FUTURE_GPS_SECONDS * 1000
    );

    const history = await VehicleHistory.aggregate([
        {
            $match: {
                vehicleId: { $in: vehicleIds },
                timestamp: {
                    $gte: cutoff,
                    $lte: futureLimit
                }
            }
        },
        {
            $sort: {
                vehicleId: 1,
                timestamp: -1
            }
        },
        {
            $group: {
                _id: "$vehicleId",
                points: {
                    $push: {
                        latitude: "$latitude",
                        longitude: "$longitude",
                        timestamp: "$timestamp"
                    }
                }
            }
        },
        {
            $project: {
                points: {
                    $slice: ["$points", HISTORY_POINT_LIMIT]
                }
            }
        }
    ]);

    return new Map(
        history.map(item => [
            String(item._id),
            item.points || []
        ])
    );
}

// --------------------------------------------------
// HISTORICAL ROUTE-AWARE SPEED
// --------------------------------------------------

async function getHistoricalSpeeds(vehicles, patterns) {
    const historyByVehicle = await getRecentVehicleHistory(vehicles);
    const speedMap = new Map();

    for (const vehicle of vehicles) {
        const vehicleId = String(vehicle.vehicleId || "");

        if (
            !vehicleId ||
            vehicle.isStale ||
            vehicle.dataStatus === "unknown"
        ) {
            continue;
        }

        const points = historyByVehicle.get(vehicleId) || [];

        if (points.length < 3) continue;

        const match = matchVehicleToPattern(vehicle, patterns);

        if (!match.matched) continue;

        const geometry = match.pattern.geometry;
        const now = Date.now();
        const projectedPoints = [];

        for (const point of points) {
            if (!isValidCoordinate(point.latitude, point.longitude)) {
                continue;
            }

            const timestamp = new Date(point.timestamp).getTime();

            if (
                !Number.isFinite(timestamp) ||
                timestamp > now + MAX_FUTURE_GPS_SECONDS * 1000 ||
                timestamp < now - MAX_HISTORY_AGE_SECONDS * 1000
            ) {
                continue;
            }

            const projection = projectPointOntoRoute(
                Number(point.latitude),
                Number(point.longitude),
                geometry
            );

            if (
                !projection ||
                projection.distanceFromRoute > MAX_ROUTE_DISTANCE
            ) {
                continue;
            }

            projectedPoints.push({
                timestamp,
                alongDistance: projection.alongDistance
            });
        }

        projectedPoints.sort((a, b) => a.timestamp - b.timestamp);

        if (projectedPoints.length < 3) continue;

        // First determine movement direction independently of speed.
        const movementIntervals = [];

        for (let i = 1; i < projectedPoints.length; i++) {
            const previous = projectedPoints[i - 1];
            const current = projectedPoints[i];

            const elapsedSeconds =
                (current.timestamp - previous.timestamp) / 1000;

            if (
                !Number.isFinite(elapsedSeconds) ||
                elapsedSeconds < MIN_HISTORY_INTERVAL_SECONDS ||
                elapsedSeconds > MAX_HISTORY_INTERVAL_SECONDS
            ) {
                continue;
            }

            const signedDistance =
                current.alongDistance - previous.alongDistance;

            // Ignore tiny GPS projection fluctuations.
            if (Math.abs(signedDistance) < 5) continue;

            movementIntervals.push({
                signedDistance,
                elapsedSeconds
            });
        }

        if (movementIntervals.length < MIN_VALID_SPEED_SAMPLES) {
            continue;
        }

        const positiveMovement = movementIntervals
            .filter(item => item.signedDistance > 0)
            .reduce((sum, item) => sum + item.signedDistance, 0);

        const negativeMovement = movementIntervals
            .filter(item => item.signedDistance < 0)
            .reduce((sum, item) => sum + Math.abs(item.signedDistance), 0);

        const totalMovement = positiveMovement + negativeMovement;

        if (totalMovement < MIN_TEMPORAL_MOVEMENT_METRES) {
            continue;
        }

        const movementDirection =
            positiveMovement >= negativeMovement
                ? "forward"
                : "reverse";

        const dominantMovement = Math.max(
            positiveMovement,
            negativeMovement
        );

        const directionConsistency =
            dominantMovement / totalMovement;

        if (directionConsistency < MIN_DIRECTION_CONSISTENCY) {
            continue;
        }

        // Calculate speed only from intervals matching dominant direction.
        const directionIntervals = movementIntervals.filter(item => {
            return movementDirection === "forward"
                ? item.signedDistance > 0
                : item.signedDistance < 0;
        });

        const intervalSpeeds = directionIntervals
            .map(item => {
                const speedKmh =
                    (Math.abs(item.signedDistance) /
                        item.elapsedSeconds) * 3.6;

                return speedKmh;
            })
            .filter(speed =>
                Number.isFinite(speed) &&
                speed > MIN_VALID_SPEED_KMH &&
                speed <= MAX_VALID_SPEED_KMH
            );

        if (intervalSpeeds.length < MIN_VALID_SPEED_SAMPLES) {
            continue;
        }

        // Median absolute deviation outlier filtering.
        const initialMedian = getMedian(intervalSpeeds);

        if (!Number.isFinite(initialMedian)) continue;

        const deviations = intervalSpeeds.map(speed =>
            Math.abs(speed - initialMedian)
        );

        const mad = getMedian(deviations) || 0;
        const outlierThreshold = Math.max(8, 3 * mad);

        const filteredSpeeds = intervalSpeeds.filter(speed =>
            Math.abs(speed - initialMedian) <= outlierThreshold
        );

        if (filteredSpeeds.length < MIN_VALID_SPEED_SAMPLES) {
            continue;
        }

        const finalMedian = getMedian(filteredSpeeds);

        if (
            !Number.isFinite(finalMedian) ||
            finalMedian <= MIN_VALID_SPEED_KMH ||
            finalMedian > MAX_VALID_SPEED_KMH
        ) {
            continue;
        }

        const averageSpeed =
            filteredSpeeds.reduce((sum, speed) => sum + speed, 0) /
            filteredSpeeds.length;

        const spreadPercent = averageSpeed > 0
            ? (
                (
                    Math.max(...filteredSpeeds) -
                    Math.min(...filteredSpeeds)
                ) / averageSpeed
            ) * 100
            : 100;

        let confidence = "low";

        if (
            filteredSpeeds.length >= 3 &&
            spreadPercent <= 20 &&
            directionConsistency >= 0.8
        ) {
            confidence = "high";
        } else if (
            filteredSpeeds.length >= 2 &&
            spreadPercent <= 40 &&
            directionConsistency >= MIN_DIRECTION_CONSISTENCY
        ) {
            confidence = "medium";
        }

        speedMap.set(vehicleId, {
            speedKmh: Number(finalMedian.toFixed(1)),
            confidence,
            sampleCount: filteredSpeeds.length,
            directionSampleCount: directionIntervals.length,
            spreadPercent: Number(spreadPercent.toFixed(1)),
            directionConsistency: Number(
                directionConsistency.toFixed(2)
            ),
            movementDirection,
            distanceMethod: "gtfs-shape-projection"
        });
    }

    return speedMap;
}


// --------------------------------------------------
// STATIC TRIP ID
// --------------------------------------------------

function getStaticTripIdFromRealtime(vehicle) {
    const relationship = vehicle.scheduleRelationship;

    if (
        relationship !== null &&
        relationship !== undefined &&
        Number(relationship) !== 0
    ) {
        return null;
    }

    const realtimeTripId = String(vehicle.tripId || "");
    const routeId = String(vehicle.routeId || "");

    if (!realtimeTripId || !routeId) return null;

    if (realtimeTripId.startsWith(`${routeId}_FULL_`)) {
        return realtimeTripId;
    }

    const prefix = `${routeId}_`;

    if (!realtimeTripId.startsWith(prefix)) return null;

    const timePart = realtimeTripId.slice(prefix.length);
    const match = timePart.match(/^(\d{2})_(\d{2})$/);

    if (!match) return null;

    return `${routeId}_FULL_${match[1]}_${match[2]}`;
}

// --------------------------------------------------
// BUILD TRIP STOPS
// --------------------------------------------------

function buildTripStops(stopTimes, stopMap, geometry) {
    const routeStops = [];

    const sortedStopTimes = [...stopTimes].sort(
        (a, b) => Number(a.stopSequence) - Number(b.stopSequence)
    );

    for (const stopTime of sortedStopTimes) {
        const stop = stopMap.get(String(stopTime.stopId));

        if (!stop) continue;

        const latitude = Number(stop.stopLat);
        const longitude = Number(stop.stopLon);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            continue;
        }

        const projection = projectPointOntoRoute(
            latitude,
            longitude,
            geometry
        );

        if (
            !projection ||
            projection.distanceFromRoute > MAX_ROUTE_DISTANCE
        ) {
            continue;
        }

        routeStops.push({
            stopId: stop.stopId,
            stopName: stop.stopName,
            latitude,
            longitude,
            stopSequence: stopTime.stopSequence,
            arrivalTime: stopTime.arrivalTime || null,
            departureTime: stopTime.departureTime || null,
            routeDistance: projection.alongDistance,
            distanceFromRoute: projection.distanceFromRoute
        });
    }

    return routeStops;
}

// --------------------------------------------------
// LOAD ROUTE PATTERNS
// --------------------------------------------------

async function getRoutePatterns(routeId) {
    const trips = await Trip.find({
        routeId: String(routeId),
        shapeId: {
            $exists: true,
            $nin: [null, ""]
        }
    })
        .select("tripId routeId shapeId tripHeadsign directionId")
        .lean();

    if (!trips.length) return [];

    const allTripIds = trips.map(trip => trip.tripId);

    const allStopTimes = await StopTime.find({
        tripId: { $in: allTripIds }
    })
        .sort({ stopSequence: 1 })
        .lean();

    const stopIds = [
        ...new Set(allStopTimes.map(item => String(item.stopId)))
    ];

    const stops = await Stop.find({
        stopId: { $in: stopIds }
    }).lean();

    const stopMap = new Map(
        stops.map(stop => [String(stop.stopId), stop])
    );

    const stopTimesByTrip = new Map();

    for (const stopTime of allStopTimes) {
        const key = String(stopTime.tripId);

        if (!stopTimesByTrip.has(key)) {
            stopTimesByTrip.set(key, []);
        }

        stopTimesByTrip.get(key).push(stopTime);
    }

    const groupedPatterns = new Map();

    for (const trip of trips) {
        const directionKey =
            trip.directionId === null ||
            trip.directionId === undefined
                ? "unknown"
                : String(trip.directionId);

        const patternKey = `${trip.shapeId}::${directionKey}`;

        if (!groupedPatterns.has(patternKey)) {
            groupedPatterns.set(patternKey, []);
        }

        groupedPatterns.get(patternKey).push(trip);
    }

    const patterns = [];

    for (const patternTrips of groupedPatterns.values()) {
        const representativeTrip = patternTrips[0];
        const shapeId = representativeTrip.shapeId;

        const shapePoints = await Shape.find({ shapeId })
            .sort({ shapePtSequence: 1 })
            .lean();

        const geometry = buildRouteGeometry(shapePoints);

        if (!geometry) continue;

        const tripsById = new Map();
        const tripSequences = [];

        for (const trip of patternTrips) {
            const tripStopTimes =
                stopTimesByTrip.get(String(trip.tripId)) || [];

            const routeStops = buildTripStops(
                tripStopTimes,
                stopMap,
                geometry
            );

            tripsById.set(String(trip.tripId), {
                trip,
                stops: routeStops
            });

            tripSequences.push(
                routeStops.map(stop => String(stop.stopId)).join("|")
            );
        }

        const hasCommonStopSequence =
            tripSequences.length > 0 &&
            tripSequences.every(
                sequence => sequence === tripSequences[0]
            );

        const firstTripData =
            tripsById.get(String(representativeTrip.tripId));

        patterns.push({
            trip: representativeTrip,
            shapeId,
            directionId:
                representativeTrip.directionId === null ||
                representativeTrip.directionId === undefined
                    ? null
                    : Number(representativeTrip.directionId),
            geometry,
            tripsById,
            commonStops: hasCommonStopSequence
                ? firstTripData.stops
                : [],
            hasCommonStopSequence
        });
    }

    return patterns;
}

// --------------------------------------------------
// MATCH VEHICLE TO DECLARED ROUTE
// --------------------------------------------------

function matchVehicleToPattern(vehicle, patterns) {
    let candidatePatterns = patterns;

    if (
        vehicle.directionId !== null &&
        vehicle.directionId !== undefined
    ) {
        const directionMatches = patterns.filter(pattern =>
            pattern.directionId === null ||
            Number(pattern.directionId) === Number(vehicle.directionId)
        );

        if (!directionMatches.length) {
            return {
                matched: false,
                reason:
                    `No static GTFS pattern found for direction ${vehicle.directionId}.`,
                nearestPattern: null
            };
        }

        candidatePatterns = directionMatches;
    }

    let bestMatch = null;

    for (const pattern of candidatePatterns) {
        const projection = projectPointOntoRoute(
            Number(vehicle.latitude),
            Number(vehicle.longitude),
            pattern.geometry
        );

        if (!projection) continue;

        if (
            !bestMatch ||
            projection.distanceFromRoute <
                bestMatch.projection.distanceFromRoute
        ) {
            bestMatch = { pattern, projection };
        }
    }

    if (!bestMatch) {
        return {
            matched: false,
            reason: "Unable to project vehicle GPS onto route geometry.",
            nearestPattern: null
        };
    }

    if (
        bestMatch.projection.distanceFromRoute >
        MAX_ROUTE_DISTANCE
    ) {
        return {
            matched: false,
            reason:
                `Vehicle is more than ${MAX_ROUTE_DISTANCE}m away from available route shapes.`,
            nearestPattern: {
                shapeId: bestMatch.pattern.shapeId,
                distanceFromRouteMetres: Math.round(
                    bestMatch.projection.distanceFromRoute
                )
            }
        };
    }

    return {
        matched: true,
        ...bestMatch
    };
}

// --------------------------------------------------
// TEMPORAL ROUTE VALIDATION
// --------------------------------------------------

function validateCandidateWithHistory(
    historyPoints,
    geometry,
    currentLatitude,
    currentLongitude
) {
    const observations = [];
    const now = Date.now();

    for (const point of historyPoints) {
        if (!isValidCoordinate(point.latitude, point.longitude)) continue;

        const timestamp = new Date(point.timestamp).getTime();

        if (
            !Number.isFinite(timestamp) ||
            timestamp > now + MAX_FUTURE_GPS_SECONDS * 1000 ||
            timestamp < now - MAX_HISTORY_AGE_SECONDS * 1000
        ) {
            continue;
        }

        const projection = projectPointOntoRoute(
            Number(point.latitude),
            Number(point.longitude),
            geometry
        );

        if (!projection) continue;

        observations.push({
            timestamp,
            alongDistance: projection.alongDistance,
            distanceFromRoute: projection.distanceFromRoute
        });
    }

    observations.sort((a, b) => a.timestamp - b.timestamp);

    const validObservations = observations.filter(point =>
        point.distanceFromRoute <= MAX_TEMPORAL_DISTANCE_METRES
    );

    const medianDistance = getMedian(
        validObservations.map(point => point.distanceFromRoute)
    );

    const signedMovements = [];

    for (let i = 1; i < validObservations.length; i++) {
        const previous = validObservations[i - 1];
        const current = validObservations[i];

        const elapsedSeconds =
            (current.timestamp - previous.timestamp) / 1000;

        if (
            elapsedSeconds < MIN_HISTORY_INTERVAL_SECONDS ||
            elapsedSeconds > MAX_HISTORY_INTERVAL_SECONDS
        ) {
            continue;
        }

        signedMovements.push(
            current.alongDistance - previous.alongDistance
        );
    }

    const totalRouteMovement = signedMovements.reduce(
        (sum, distance) => sum + Math.abs(distance),
        0
    );

    const netRouteMovement = signedMovements.reduce(
        (sum, distance) => sum + distance,
        0
    );

    const directionConsistency = totalRouteMovement > 0
        ? Math.abs(netRouteMovement) / totalRouteMovement
        : 0;

    const movementDirection = netRouteMovement >= 0
        ? "forward"
        : "reverse";

    const currentProjection = projectPointOntoRoute(
        currentLatitude,
        currentLongitude,
        geometry
    );

    const enoughObservations =
        validObservations.length >= MIN_TEMPORAL_OBSERVATIONS;

    const movementSupported =
        totalRouteMovement >= MIN_TEMPORAL_MOVEMENT_METRES &&
        totalRouteMovement <= MAX_TEMPORAL_MOVEMENT_METRES &&
        directionConsistency >= MIN_DIRECTION_CONSISTENCY;

    const currentPointSupported =
        currentProjection &&
        currentProjection.distanceFromRoute <= MAX_TEMPORAL_DISTANCE_METRES;

    const temporallySupported =
        enoughObservations &&
        movementSupported &&
        currentPointSupported;

    return {
        status: temporallySupported
            ? "temporally-supported"
            : "insufficient-temporal-evidence",
        observationsChecked: observations.length,
        observationsMatched: validObservations.length,
        medianDistanceMetres: medianDistance === null
            ? null
            : Math.round(medianDistance),
        routeMovementMetres: Math.round(totalRouteMovement),
        netRouteMovementMetres: Math.round(netRouteMovement),
        directionConsistency: Number(directionConsistency.toFixed(2)),
        movementDirection,
        movementSupported,
        currentPointSupported: Boolean(currentPointSupported),
        requiredObservations: MIN_TEMPORAL_OBSERVATIONS,
        reason: temporallySupported
            ? "Multiple historical GPS observations support consistent movement along this route shape."
            : !enoughObservations
                ? "Not enough historical GPS observations near this shape."
                : !movementSupported
                    ? "Historical GPS movement is too small, too large, or directionally inconsistent."
                    : "Current GPS position is not sufficiently close to this shape."
    };
}

// --------------------------------------------------
// ROUTE CANDIDATE DISAMBIGUATION
// --------------------------------------------------

function normalizeText(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function calculateOrderedSequenceSimilarity(sequenceA, sequenceB) {
    if (!sequenceA?.length || !sequenceB?.length) return 0;

    const a = sequenceA.slice(0, MAX_SEQUENCE_LENGTH);
    const b = sequenceB.slice(0, MAX_SEQUENCE_LENGTH);

    let previous = new Array(b.length + 1).fill(0);

    for (let i = 1; i <= a.length; i++) {
        const current = new Array(b.length + 1).fill(0);

        for (let j = 1; j <= b.length; j++) {
            if (String(a[i - 1]) === String(b[j - 1])) {
                current[j] = previous[j - 1] + 1;
            } else {
                current[j] = Math.max(
                    previous[j],
                    current[j - 1]
                );
            }
        }

        previous = current;
    }

    const lcsLength = previous[b.length];

    return Number(
        (lcsLength / Math.max(a.length, b.length)).toFixed(3)
    );
}

async function getDeclaredTripEvidence(vehicle) {
    const staticTripId = getStaticTripIdFromRealtime(vehicle);

    if (!staticTripId) {
        return {
            available: false,
            reason: "Realtime trip ID could not be resolved to a static GTFS trip."
        };
    }

    const trip = await Trip.findOne({
        tripId: staticTripId
    })
        .select("tripId routeId shapeId tripHeadsign directionId")
        .lean();

    if (!trip) {
        return {
            available: false,
            staticTripId,
            reason: "Resolved static trip was not found in GTFS."
        };
    }

    const stopTimes = await StopTime.find({
        tripId: staticTripId
    })
        .sort({ stopSequence: 1 })
        .select("stopId stopSequence")
        .lean();

    return {
        available: stopTimes.length > 0,
        staticTripId,
        trip,
        stopIds: stopTimes.map(item => String(item.stopId)),
        reason: stopTimes.length
            ? null
            : "No static stop sequence was found for the declared trip."
    };
}

async function getCandidateStopEvidence(candidate) {
    const trips = await Trip.find({
        routeId: String(candidate.routeId),
        shapeId: String(candidate.shapeId)
    })
        .select("tripId routeId shapeId tripHeadsign directionId")
        .limit(MAX_DISAMBIGUATION_TRIPS)
        .lean();

    if (!trips.length) {
        return {
            available: false,
            tripsChecked: 0,
            sequences: [],
            reason: "No candidate static trips found."
        };
    }

    const tripIds = trips.map(trip => String(trip.tripId));

    const stopTimes = await StopTime.find({
        tripId: { $in: tripIds }
    })
        .sort({ tripId: 1, stopSequence: 1 })
        .select("tripId stopId stopSequence")
        .limit(MAX_DISAMBIGUATION_STOP_TIMES)
        .lean();

    const stopTimesByTrip = new Map();

    for (const item of stopTimes) {
        const key = String(item.tripId);

        if (!stopTimesByTrip.has(key)) {
            stopTimesByTrip.set(key, []);
        }

        stopTimesByTrip.get(key).push(String(item.stopId));
    }

    const sequences = [];

    for (const trip of trips) {
        const stopIds = stopTimesByTrip.get(String(trip.tripId)) || [];

        if (!stopIds.length) continue;

        sequences.push({
            tripId: String(trip.tripId),
            headsign: trip.tripHeadsign || null,
            directionId:
                trip.directionId === null ||
                trip.directionId === undefined
                    ? null
                    : Number(trip.directionId),
            stopIds
        });
    }

    return {
        available: sequences.length > 0,
        tripsChecked: trips.length,
        sequences,
        stopTimesChecked: stopTimes.length,
        tripLimitReached: trips.length >= MAX_DISAMBIGUATION_TRIPS,
        stopTimeLimitReached:
            stopTimes.length >= MAX_DISAMBIGUATION_STOP_TIMES,
        reason: sequences.length
            ? null
            : "Candidate trips did not have usable stop sequences."
    };
}

function scoreRouteCandidate(
    candidate,
    declaredEvidence,
    candidateEvidence
) {
    let score = 0;
    const evidence = [];

    const distance = candidate.distanceFromVehicleMetres;

    let geometryScore = 0;

    if (distance <= 30) geometryScore = 25;
    else if (distance <= 75) geometryScore = 20;
    else if (distance <= 150) geometryScore = 15;
    else if (distance <= 500) geometryScore = 8;
    else geometryScore = 2;

    score += geometryScore;

    evidence.push({
        type: "geometry",
        score: geometryScore,
        maximumScore: 25,
        distanceMetres: distance
    });

    const temporalSupported =
        candidate.temporalValidation?.status === "temporally-supported";

    const temporalScore = temporalSupported ? 25 : 0;

    score += temporalScore;

    evidence.push({
        type: "temporal-movement",
        score: temporalScore,
        maximumScore: 25,
        status: candidate.temporalValidation?.status || "unavailable",
        direction: candidate.temporalValidation?.movementDirection || null
    });

    let bestSimilarity = null;
    let bestMatchingTrip = null;

    if (
        declaredEvidence.available &&
        candidateEvidence.available
    ) {
        for (const candidateTrip of candidateEvidence.sequences) {
            const similarity = calculateOrderedSequenceSimilarity(
                declaredEvidence.stopIds,
                candidateTrip.stopIds
            );

            if (
                bestSimilarity === null ||
                similarity > bestSimilarity
            ) {
                bestSimilarity = similarity;
                bestMatchingTrip = candidateTrip;
            }
        }
    }

    let sequenceScore = 0;

    if (bestSimilarity !== null) {
        sequenceScore = Math.round(bestSimilarity * 40);
        score += sequenceScore;

        evidence.push({
            type: "ordered-stop-sequence",
            score: sequenceScore,
            maximumScore: 40,
            similarity: bestSimilarity,
            matchedCandidateTripId: bestMatchingTrip?.tripId || null
        });
    } else {
        evidence.push({
            type: "ordered-stop-sequence",
            score: 0,
            maximumScore: 40,
            similarity: null,
            reason: "Declared or candidate static stop sequence unavailable."
        });
    }

    const declaredHeadsign = normalizeText(
        declaredEvidence.trip?.tripHeadsign
    );

    const candidateHeadsign = normalizeText(
        bestMatchingTrip?.headsign
    );

    let headsignScore = 0;

    if (
        declaredHeadsign &&
        candidateHeadsign &&
        declaredHeadsign === candidateHeadsign
    ) {
        headsignScore = 10;
        score += headsignScore;
    }

    evidence.push({
        type: "headsign",
        score: headsignScore,
        maximumScore: 10,
        declaredHeadsign:
            declaredEvidence.trip?.tripHeadsign || null,
        candidateHeadsign:
            bestMatchingTrip?.headsign || null,
        matched: headsignScore > 0
    });

    const directionEvidence = {
        declaredDirectionId:
            declaredEvidence.trip?.directionId ?? null,
        candidateDirectionIds: candidate.directionIds || [],
        comparison: "not-scored-across-different-routes"
    };

    let confidence = "low";

    if (
        score >= 75 &&
        bestSimilarity !== null &&
        bestSimilarity >= 0.75 &&
        temporalSupported
    ) {
        confidence = "high";
    } else if (
        score >= 50 &&
        (
            temporalSupported ||
            (bestSimilarity !== null && bestSimilarity >= 0.5)
        )
    ) {
        confidence = "medium";
    }

    return {
        score,
        maximumScore: 100,
        confidence,
        evidence,
        stopSequenceSimilarity: bestSimilarity,
        bestMatchingStaticTripId: bestMatchingTrip?.tripId || null,
        directionEvidence,
        candidateStopEvidence: {
            tripsChecked: candidateEvidence.tripsChecked || 0,
            sequencesFound: candidateEvidence.sequences?.length || 0,
            stopTimesChecked: candidateEvidence.stopTimesChecked || 0,
            tripLimitReached: Boolean(candidateEvidence.tripLimitReached),
            stopTimeLimitReached: Boolean(candidateEvidence.stopTimeLimitReached)
        }
    };
}

async function disambiguateRouteCandidates(vehicle, candidates) {
    if (!candidates.length) return [];

    const declaredEvidence = await getDeclaredTripEvidence(vehicle);
    const rankedCandidates = [];

    for (const candidate of candidates) {
        const candidateEvidence =
            await getCandidateStopEvidence(candidate);

        const disambiguation = scoreRouteCandidate(
            candidate,
            declaredEvidence,
            candidateEvidence
        );

        rankedCandidates.push({
            ...candidate,
            disambiguation
        });
    }

    rankedCandidates.sort((a, b) => {
        const aSupported =
            a.temporalValidation.status === "temporally-supported";

        const bSupported =
            b.temporalValidation.status === "temporally-supported";

        if (aSupported !== bSupported) {
            return aSupported ? -1 : 1;
        }

        if (
            a.disambiguation.score !==
            b.disambiguation.score
        ) {
            return (
                b.disambiguation.score -
                a.disambiguation.score
            );
        }

        return (
            a.distanceFromVehicleMetres -
            b.distanceFromVehicleMetres
        );
    });

    for (let i = 0; i < rankedCandidates.length; i++) {
        const current = rankedCandidates[i];
        const next = rankedCandidates[i + 1];

        let ambiguity = "none";

        if (
            next &&
            current.temporalValidation.status === "temporally-supported" &&
            next.temporalValidation.status === "temporally-supported" &&
            Math.abs(
                current.disambiguation.score -
                next.disambiguation.score
            ) <= 5
        ) {
            ambiguity = "multiple-supported-candidates-have-similar-scores";
        }

        current.disambiguation.ambiguity = ambiguity;

        current.disambiguation.recommendation =
            ambiguity !== "none"
                ? "ambiguous"
                : current.disambiguation.confidence === "high"
                    ? "strongest-diagnostic-candidate"
                    : current.disambiguation.confidence === "medium"
                        ? "candidate-priority-only"
                        : "insufficient-evidence";
    }

    return rankedCandidates;
}

// --------------------------------------------------
// ALTERNATIVE ROUTE DIAGNOSTIC
// --------------------------------------------------

async function findAlternativeRouteCandidates(vehicles) {
    const validVehicles = vehicles.filter(vehicle =>
        isValidCoordinate(vehicle.latitude, vehicle.longitude)
    );

    if (!validVehicles.length) return new Map();

    const historyByVehicle =
        await getRecentVehicleHistory(validVehicles);

    const searchConditions = validVehicles.map(vehicle => {
        const lat = Number(vehicle.latitude);
        const lon = Number(vehicle.longitude);

        const latitudeDelta =
            DIAGNOSTIC_RADIUS_METRES / 111320;

        const longitudeDelta =
            DIAGNOSTIC_RADIUS_METRES /
            (111320 * Math.max(
                Math.cos(lat * Math.PI / 180),
                0.1
            ));

        return {
            shapePtLat: {
                $gte: lat - latitudeDelta,
                $lte: lat + latitudeDelta
            },
            shapePtLon: {
                $gte: lon - longitudeDelta,
                $lte: lon + longitudeDelta
            }
        };
    });

    const nearbyShapeIds = await Shape.distinct("shapeId", {
        $or: searchConditions
    });

    if (!nearbyShapeIds.length) return new Map();

    const nearbyShapePoints = await Shape.find({
        shapeId: { $in: nearbyShapeIds }
    })
        .select("shapeId shapePtLat shapePtLon shapePtSequence")
        .lean();

    const pointsByShape = new Map();

    for (const point of nearbyShapePoints) {
        const key = String(point.shapeId);

        if (!pointsByShape.has(key)) {
            pointsByShape.set(key, []);
        }

        pointsByShape.get(key).push(point);
    }

    const trips = await Trip.find({
        shapeId: { $in: nearbyShapeIds }
    })
        .select("routeId shapeId directionId tripHeadsign")
        .lean();

    const tripsByShape = new Map();

    for (const trip of trips) {
        const key = String(trip.shapeId);

        if (!tripsByShape.has(key)) {
            tripsByShape.set(key, []);
        }

        tripsByShape.get(key).push(trip);
    }

    const geometryByShape = new Map();

    for (const [shapeId, points] of pointsByShape.entries()) {
        const geometry = buildRouteGeometry(points);

        if (geometry) {
            geometryByShape.set(shapeId, geometry);
        }
    }

    const results = new Map();

    for (const vehicle of validVehicles) {
        const vehicleLat = Number(vehicle.latitude);
        const vehicleLon = Number(vehicle.longitude);
        const declaredRouteId = String(vehicle.routeId || "");

        const vehicleKey = String(
            vehicle.vehicleId ||
            `${vehicle.tripId}:${vehicle.latitude}:${vehicle.longitude}`
        );

        const historyPoints =
            historyByVehicle.get(String(vehicle.vehicleId || "")) || [];

        const candidates = [];

        for (const [shapeId, geometry] of geometryByShape.entries()) {
            const projection = projectPointOntoRoute(
                vehicleLat,
                vehicleLon,
                geometry
            );

            if (
                !projection ||
                projection.distanceFromRoute > DIAGNOSTIC_RADIUS_METRES
            ) {
                continue;
            }

            const shapeTrips = tripsByShape.get(shapeId) || [];

            if (!shapeTrips.length) continue;

            const routeGroups = new Map();

            for (const trip of shapeTrips) {
                const routeId = String(trip.routeId || "");

                if (!routeId || routeId === declaredRouteId) continue;

                if (!routeGroups.has(routeId)) {
                    routeGroups.set(routeId, {
                        routeId,
                        shapeId,
                        staticTripCount: 0,
                        directionIds: new Set(),
                        tripHeadsigns: new Set()
                    });
                }

                const group = routeGroups.get(routeId);

                group.staticTripCount++;

                if (
                    trip.directionId !== null &&
                    trip.directionId !== undefined
                ) {
                    group.directionIds.add(Number(trip.directionId));
                }

                if (trip.tripHeadsign) {
                    group.tripHeadsigns.add(trip.tripHeadsign);
                }
            }

            for (const group of routeGroups.values()) {
                const distance = Math.round(
                    projection.distanceFromRoute
                );

                let geometricConfidence = "low";

                if (distance <= 30) {
                    geometricConfidence = "very-high";
                } else if (distance <= 75) {
                    geometricConfidence = "high";
                } else if (distance <= 150) {
                    geometricConfidence = "medium";
                }

                const temporalValidation =
                    validateCandidateWithHistory(
                        historyPoints,
                        geometry,
                        vehicleLat,
                        vehicleLon
                    );

                candidates.push({
                    routeId: group.routeId,
                    shapeId: group.shapeId,
                    distanceFromVehicleMetres: distance,
                    alongDistanceMetres: Math.round(projection.alongDistance),
                    geometricConfidence,
                    temporalValidation,
                    staticTripCount: group.staticTripCount,
                    directionIds: [...group.directionIds],
                    tripHeadsigns: [...group.tripHeadsigns].slice(0, 3)
                });
            }
        }

        const uniqueCandidates = new Map();

        for (const candidate of candidates) {
            const key = `${candidate.routeId}::${candidate.shapeId}`;
            const existing = uniqueCandidates.get(key);

            if (
                !existing ||
                candidate.distanceFromVehicleMetres <
                    existing.distanceFromVehicleMetres
            ) {
                uniqueCandidates.set(key, candidate);
            }
        }

        const initialCandidates = [...uniqueCandidates.values()]
            .sort((a, b) => {
                const aSupported =
                    a.temporalValidation.status === "temporally-supported";

                const bSupported =
                    b.temporalValidation.status === "temporally-supported";

                if (aSupported !== bSupported) {
                    return aSupported ? -1 : 1;
                }

                return (
                    a.distanceFromVehicleMetres -
                    b.distanceFromVehicleMetres
                );
            })
            .slice(0, MAX_ALTERNATIVE_CANDIDATES);

        const sortedCandidates = await disambiguateRouteCandidates(
            vehicle,
            initialCandidates
        );

        const supportedCount = sortedCandidates.filter(candidate =>
            candidate.temporalValidation.status === "temporally-supported"
        ).length;

        const bestSupportedCandidate = sortedCandidates.find(candidate =>
            candidate.temporalValidation.status === "temporally-supported"
        );

        if (bestSupportedCandidate) {
            const candidateGeometry = geometryByShape.get(
                String(bestSupportedCandidate.shapeId)
            );

            if (candidateGeometry) {
                bestSupportedCandidate.provisionalPrediction =
                    await buildAlternativeRoutePrediction(
                        vehicle,
                        bestSupportedCandidate,
                        candidateGeometry
                    );
            }
        }

        const bestCandidate = sortedCandidates[0] || null;

        const ambiguous = Boolean(
            bestCandidate &&
            bestCandidate.disambiguation?.ambiguity !== "none"
        );

        results.set(vehicleKey, {
            status: supportedCount
                ? ambiguous
                    ? "temporal-evidence-found-but-ambiguous"
                    : "temporal-evidence-found"
                : sortedCandidates.length
                    ? "candidate-only"
                    : "no-nearby-alternative-shape",

            declaredRouteId,
            declaredTripEvidence: {
                available: Boolean(
                    bestCandidate?.disambiguation?.evidence?.some(
                        item =>
                            item.type === "ordered-stop-sequence" &&
                            item.similarity !== null
                    )
                ),
                staticTripId:
                    getStaticTripIdFromRealtime(vehicle)
            },
            searchRadiusMetres: DIAGNOSTIC_RADIUS_METRES,
            historyWindowMinutes: HISTORY_WINDOW_MINUTES,
            historyPointsAvailable: historyPoints.length,
            temporallySupportedCandidates: supportedCount,

            bestDiagnosticCandidate: bestCandidate
                ? {
                    routeId: bestCandidate.routeId,
                    shapeId: bestCandidate.shapeId,
                    score: bestCandidate.disambiguation.score,
                    confidence: bestCandidate.disambiguation.confidence,
                    recommendation:
                        bestCandidate.disambiguation.recommendation
                }
                : null,

            candidates: sortedCandidates,

            note:
                "Candidate score is a diagnostic ranking heuristic, not a probability of route identity. Stop sequence, temporal movement and geometry are supporting evidence only. Direction IDs are not compared across different route IDs. The declared realtime route and trip IDs are never automatically reassigned."
        });
    }

    return results;
}

// --------------------------------------------------
// DISTANCE FORMATTING
// --------------------------------------------------

function formatDistance(metres) {
    if (metres < 1000) {
        return `${Math.round(metres)} metres`;
    }

    return `${(metres / 1000).toFixed(2)} km`;
}

// --------------------------------------------------
// NEXT STOP AND ETA
// --------------------------------------------------

function getNextStopPrediction(
    vehicle,
    stops,
    projection,
    historicalSpeedData = null
) {
    if (
        vehicle.isStale ||
        vehicle.dataStatus === "unknown"
    ) {
        return {
            available: false,
            reason: "GPS data is stale or unavailable."
        };
    }

    if (
        !projection ||
        !Number.isFinite(projection.alongDistance)
    ) {
        return {
            available: false,
            reason: "Vehicle route projection is unavailable."
        };
    }

    const nextStop = stops.find(stop =>
        Number(stop.routeDistance) >
        projection.alongDistance + PASSED_STOP_TOLERANCE
    );

    if (!nextStop) {
        return {
            available: false,
            atEnd: true,
            reason: "No upcoming stop on this route."
        };
    }

    const remainingDistance = Math.max(
        0,
        Number(nextStop.routeDistance) - projection.alongDistance
    );

    const liveSpeed = Number(vehicle.speed);

    const validLiveSpeed =
        vehicle.speed !== null &&
        vehicle.speed !== undefined &&
        vehicle.speed !== "" &&
        Number.isFinite(liveSpeed) &&
        liveSpeed > MIN_VALID_SPEED_KMH &&
        liveSpeed <= MAX_VALID_SPEED_KMH;

    let speed = null;
    let speedSource = "unavailable";
    let speedConfidence = "unavailable";
    let speedSampleCount = 0;
    let speedVehicleCount = null;
let baselineHour = null;
    let speedSpreadPercent = null;
    let distanceMethod = null;
    let movementDirection = null;

    // Live speed takes priority when the GPS record is fresh.
    if (validLiveSpeed) {
        speed = liveSpeed;
        speedSource = vehicle.speedSource || "live";
        speedConfidence = "live-feed";
    } else if (
        historicalSpeedData &&
        Number.isFinite(historicalSpeedData.speedKmh) &&
        historicalSpeedData.speedKmh > MIN_VALID_SPEED_KMH &&
        historicalSpeedData.speedKmh <= MAX_VALID_SPEED_KMH &&
        ["medium", "high"].includes(historicalSpeedData.confidence) &&
        Number(historicalSpeedData.sampleCount) >= MIN_VALID_SPEED_SAMPLES
    ) {
        speed = historicalSpeedData.speedKmh;
        speedSource = "historical-gps";
        speedConfidence = historicalSpeedData.confidence;
        speedSampleCount = historicalSpeedData.sampleCount;
        speedVehicleCount = baseline.vehicleCount;
baselineHour = baseline.hour;
        speedSpreadPercent =
            historicalSpeedData.spreadPercent ?? null;
        distanceMethod =
            historicalSpeedData.distanceMethod || null;
        movementDirection =
            historicalSpeedData.movementDirection || null;
    }
    // Route-hourly historical baseline fallback.
    if (speed === null && historicalSpeedData?.routeHourlyBaseline) {
        const baseline = historicalSpeedData.routeHourlyBaseline;

        speed = baseline.speedKmh;
        speedSource = "route-hourly-baseline";
        speedConfidence = "low";
        speedSampleCount = baseline.sampleCount;
    }


    if (speed === null) {
        return {
            available: false,
            reason:
                "Reliable live speed or medium/high-confidence historical speed is unavailable.",
            stop: nextStop,
            distanceMetres: Math.round(remainingDistance),
            distance: formatDistance(remainingDistance),
            speedKmh: null,
            speedSource,
            speedConfidence,
            speedSampleCount,
            speedVehicleCount,
baselineHour,
            speedSpreadPercent,
            distanceMethod,
            movementDirection
        };
    }

    const etaMinutes =
        remainingDistance / (speed * 1000 / 60);

    let etaText;

    if (etaMinutes < 1) {
        etaText = "Less than 1 min";
    } else if (etaMinutes < 60) {
        etaText = `${Math.round(etaMinutes)} min`;
    } else {
        const hours = Math.floor(etaMinutes / 60);
        const minutes = Math.round(etaMinutes % 60);

        etaText = `${hours} hr ${minutes} min`;
    }

    return {
        available: true,
        stop: nextStop,
        distanceMetres: Math.round(remainingDistance),
        distance: formatDistance(remainingDistance),
        etaMinutes: Math.round(etaMinutes * 10) / 10,
        eta: etaText,
        speedKmh: Number(speed.toFixed(1)),
        speedSource,
        speedConfidence,
        speedSampleCount,
        speedVehicleCount,
        baselineHour,
        speedSpreadPercent,
        distanceMethod,
        movementDirection
    };
}

// --------------------------------------------------
// APPLY DIRECTION TO STOPS AND PROJECTION
// --------------------------------------------------

function orientPredictionForMovement(
    stops,
    projection,
    totalDistance,
    movementDirection
) {
    const reverse = movementDirection === "reverse";

    if (!reverse) {
        return {
            stops: [...stops].sort(
                (a, b) => a.routeDistance - b.routeDistance
            ),
            projection: {
                ...projection,
                alongDistance: projection.alongDistance
            }
        };
    }

    const reversedStops = stops.map(stop => ({
        ...stop,
        routeDistance: totalDistance - Number(stop.routeDistance)
    }));

    reversedStops.sort(
        (a, b) => a.routeDistance - b.routeDistance
    );

    return {
        stops: reversedStops,
        projection: {
            ...projection,
            alongDistance: totalDistance - projection.alongDistance
        }
    };
}

// --------------------------------------------------
// PROVISIONAL PREDICTION FOR VERIFIED ALTERNATIVE ROUTE
// --------------------------------------------------

async function buildAlternativeRoutePrediction(vehicle, candidate, geometry) {
    const validation = candidate.temporalValidation || {};

    if (validation.status !== "temporally-supported") {
        return {
            available: false,
            reason: "Alternative route does not have sufficient temporal GPS evidence."
        };
    }

    const trips = await Trip.find({
        routeId: String(candidate.routeId),
        shapeId: String(candidate.shapeId)
    })
        .select("tripId routeId shapeId tripHeadsign directionId")
        .lean();

    if (!trips.length) {
        return {
            available: false,
            stopSequenceVerified: false,
            reason: "No static trips were found for the alternative route."
        };
    }

    const tripIds = trips.map(trip => String(trip.tripId));

    const stopTimes = await StopTime.find({
        tripId: { $in: tripIds }
    })
        .sort({ tripId: 1, stopSequence: 1 })
        .lean();

    const stopIds = [
        ...new Set(stopTimes.map(item => String(item.stopId)))
    ];

    const stops = await Stop.find({
        stopId: { $in: stopIds }
    }).lean();

    const stopMap = new Map(
        stops.map(stop => [String(stop.stopId), stop])
    );

    const stopTimesByTrip = new Map();

    for (const stopTime of stopTimes) {
        const key = String(stopTime.tripId);

        if (!stopTimesByTrip.has(key)) {
            stopTimesByTrip.set(key, []);
        }

        stopTimesByTrip.get(key).push(stopTime);
    }

    const tripStopLists = [];

    for (const trip of trips) {
        const tripSequence = buildTripStops(
            stopTimesByTrip.get(String(trip.tripId)) || [],
            stopMap,
            geometry
        );

        tripStopLists.push({
            trip,
            stops: tripSequence,
            sequence: tripSequence.map(stop => String(stop.stopId)).join("|")
        });
    }

    const firstSequence = tripStopLists[0]?.sequence || "";

    const hasCommonStopSequence =
        Boolean(firstSequence) &&
        tripStopLists.every(item => item.sequence === firstSequence);

    if (!hasCommonStopSequence) {
        return {
            available: false,
            stopSequenceVerified: false,
            tripsChecked: trips.length,
            reason: "Static trips on this route do not share one verified stop sequence; provisional prediction was withheld."
        };
    }

    const projection = projectPointOntoRoute(
        Number(vehicle.latitude),
        Number(vehicle.longitude),
        geometry
    );

    if (!projection) {
        return {
            available: false,
            stopSequenceVerified: true,
            tripsChecked: trips.length,
            reason: "Unable to project current GPS position onto the alternative route."
        };
    }

    const movementDirection =
        validation.movementDirection === "reverse"
            ? "reverse"
            : "forward";

    const oriented = orientPredictionForMovement(
        tripStopLists[0].stops,
        projection,
        geometry.totalDistance,
        movementDirection
    );

    const prediction = getNextStopPrediction(
        vehicle,
        oriented.stops,
        oriented.projection,
        null
    );

    return {
        available: prediction.available,
        routeId: String(candidate.routeId),
        shapeId: String(candidate.shapeId),
        movementDirection,
        stopSequenceVerified: true,
        tripsChecked: trips.length,

        nextStop: prediction.stop
            ? {
                stopId: prediction.stop.stopId,
                stopName: prediction.stop.stopName,
                distanceMetres: prediction.distanceMetres,
                distance: prediction.distance,
                eta: prediction.eta || null,
                etaMinutes: prediction.etaMinutes ?? null,
                available: prediction.available,
                speedKmh: prediction.speedKmh ?? null,
                speedSource: prediction.speedSource || "unavailable",
                speedConfidence: prediction.speedConfidence || "unavailable"
            }
            : null,

        reason: prediction.reason || null,

        disclaimer:
            "Provisional alternative-route prediction based on historical GPS direction and a verified static stop sequence. The realtime route ID is not changed; ETA assumes constant speed and does not model traffic or stop dwell time."
    };
}

// --------------------------------------------------
// ADD ROUTE PROGRESS
// --------------------------------------------------

function addRouteProgress(
    vehicle,
    patterns,
    historicalSpeedData = null
) {
    const match = matchVehicleToPattern(vehicle, patterns);

    if (!match.matched) {
        return {
            ...vehicle,
            routeProgress: {
                matched: false,
                reason: match.reason,
                nearestDeclaredRouteShape: match.nearestPattern
            }
        };
    }

    const { pattern, projection } = match;


    const routeHourlyData = getRouteHourlyBaseline(
        pattern.trip.routeId
    );

    const predictionSpeedData = {
        ...(historicalSpeedData || {}),
        routeHourlyBaseline: routeHourlyData
    };



    const staticTripId =
        getStaticTripIdFromRealtime(vehicle);

    const exactTripData = staticTripId
        ? pattern.tripsById.get(staticTripId)
        : null;

    let predictionStops = [];
    let stopSequenceSource = "unavailable";

    if (exactTripData) {
        predictionStops = exactTripData.stops;
        stopSequenceSource = "exact-static-trip";
    } else if (pattern.hasCommonStopSequence) {
        predictionStops = pattern.commonStops;
        stopSequenceSource = "common-route-pattern";
    }

    const nearestStop = pattern.commonStops.length
        ? pattern.commonStops.reduce(
            (nearest, stop) => {
                const distance = getDistance(
                    Number(vehicle.latitude),
                    Number(vehicle.longitude),
                    stop.latitude,
                    stop.longitude
                );

                if (!nearest || distance < nearest.distance) {
                    return { stop, distance };
                }

                return nearest;
            },
            null
        )
        : null;

    let prediction = {
        available: false,
        reason: "No verified stop sequence is available."
    };

    if (predictionStops.length) {
const reliableDirection =
    historicalSpeedData &&
    ["medium", "high"].includes(historicalSpeedData.confidence) &&
    Number(historicalSpeedData.directionConsistency) >= 0.8 &&
    Number(historicalSpeedData.directionSampleCount) >= 2;

const movementDirection = reliableDirection
    ? historicalSpeedData.movementDirection
    : "forward";

        const oriented = orientPredictionForMovement(
            predictionStops,
            projection,
            pattern.geometry.totalDistance,
            movementDirection
        );

        prediction = getNextStopPrediction(
            vehicle,
            oriented.stops,
            oriented.projection,
             predictionSpeedData
                    );
    }

    return {
        ...vehicle,

        routeProgress: {
            matched: true,

            shapeId: pattern.shapeId,
            directionId: pattern.directionId,

            matchedStaticTripId:
                exactTripData
                    ? exactTripData.trip.tripId
                    : null,

            staticTripMatch: Boolean(exactTripData),

            tripHeadsign:
                exactTripData?.trip.tripHeadsign ||
                pattern.trip.tripHeadsign ||
                null,

            stopSequenceSource,

            currentDistanceMetres: Math.round(
                projection.alongDistance
            ),

            totalDistanceMetres: Math.round(
                pattern.geometry.totalDistance
            ),

            remainingRouteMetres: Math.max(
                0,
                Math.round(
                    pattern.geometry.totalDistance -
                    projection.alongDistance
                )
            ),

            distanceFromRouteMetres: Math.round(
                projection.distanceFromRoute
            ),

            progressPercentage: Number(
                (
                    projection.alongDistance /
                    pattern.geometry.totalDistance *
                    100
                ).toFixed(1)
            ),

            nearestStop: nearestStop
                ? {
                    stopId: nearestStop.stop.stopId,
                    stopName: nearestStop.stop.stopName,
                    distanceMetres: Math.round(
                        nearestStop.distance
                    )
                }
                : null,

            nextStop:
                prediction.available || prediction.stop
                    ? {
                        stopId: prediction.stop.stopId,
                        stopName: prediction.stop.stopName,
                        distanceMetres: prediction.distanceMetres,
                        distance: prediction.distance,
                        eta: prediction.eta || null,
                        etaMinutes: prediction.etaMinutes ?? null,
                        available: prediction.available,
                        speedKmh: prediction.speedKmh ?? null,
                        speedSource:
                            prediction.speedSource || "unavailable",
                        speedConfidence:
                            prediction.speedConfidence || "unavailable",
                        speedSampleCount:
                            prediction.speedSampleCount ?? 0,
                            speedVehicleCount:
    prediction.speedVehicleCount ?? null,

baselineHour:
    prediction.baselineHour ?? null,
                        speedSpreadPercent:
                            prediction.speedSpreadPercent ?? null,
                        distanceMethod:
                            prediction.distanceMethod ?? null,
                        movementDirection:
                            prediction.movementDirection ?? null,
                        reason: prediction.reason || null
                    }
                    : null,

            predictionReason: prediction.reason || null,
            atEnd: prediction.atEnd || false
        }
    };
}
// --------------------------------------------------
// ROUTE NAME LOOKUP FOR LIVE VEHICLES
// --------------------------------------------------

async function attachRouteDetails(vehicles) {
    const routeIds = [
        ...new Set(
            vehicles
                .map(vehicle => String(vehicle.routeId || "").trim())
                .filter(Boolean)
        )
    ];

    if (!routeIds.length) return vehicles;

    const routes = await Route.find({
        routeId: { $in: routeIds }
    })
        .select("routeId routeShortName routeLongName")
        .lean();

    const routeMap = new Map(
        routes.map(route => [String(route.routeId), route])
    );

    return vehicles.map(vehicle => {
        const route = routeMap.get(String(vehicle.routeId || ""));

        return {
            ...vehicle,

            routeShortName: route?.routeShortName || null,

            routeLongName: route?.routeLongName || null,

            routeName:
                route?.routeLongName ||
                route?.routeShortName ||
                null
        };
    });
}
// --------------------------------------------------
// GET ALL LIVE VEHICLES
// --------------------------------------------------
router.get("/vehicles", async (req, res) => {
    try {
        const data = await getLiveVehicles();

        const vehiclesWithStatus = data.vehicles.map(addVehicleStatus);

        const vehicles = await attachRouteDetails(vehiclesWithStatus);

        res.status(200).json({
            success: true,
            count: vehicles.length,
            vehicles
        });

    } catch (error) {
        console.error("Live Vehicles Error:", error.message);

        res.status(500).json({
            success: false,
            message: "Unable to fetch live vehicles",
            error: error.message
        });
    }
});

// --------------------------------------------------
// GET LIVE VEHICLES BY ROUTE
// --------------------------------------------------

router.get("/vehicles/route/:routeId", async (req, res) => {
    try {
        const { routeId } = req.params;

        const data = await getLiveVehicles();

        const vehicles = data.vehicles
            .filter(vehicle =>
                String(vehicle.routeId) === String(routeId)
            )
            .map(addVehicleStatus);

        res.json({
            success: true,
            routeId,
            totalVehicles: vehicles.length,
            vehicles
        });

    } catch (error) {
        console.error("Route Live Vehicles Error:", error.message);

        res.status(500).json({
            success: false,
            message: "Unable to fetch route vehicles",
            error: error.message
        });
    }
});

// --------------------------------------------------
// GET LIVE VEHICLES WITH ROUTE PROGRESS
// --------------------------------------------------

router.get(
    "/vehicles/route/:routeId/progress",
    async (req, res) => {
        try {
            const { routeId } = req.params;

            const data = await getLiveVehicles();

            const routeVehicles = data.vehicles
                .filter(vehicle =>
                    String(vehicle.routeId) === String(routeId)
                )
                .map(addVehicleStatus)
                .filter(vehicle =>
                    isValidCoordinate(
                        vehicle.latitude,
                        vehicle.longitude
                    )
                );

            if (!routeVehicles.length) {
                return res.json({
                    success: true,
                    routeId,
                    totalVehicles: 0,
                    matchedVehicles: 0,
                    unmatchedVehicles: 0,
                    message: "No live vehicles found for this route.",
                    vehicles: []
                });
            }

            const patterns = await getRoutePatterns(routeId);

            if (!patterns.length) {
                return res.status(404).json({
                    success: false,
                    routeId,
                    message:
                        "No valid static GTFS route shapes or stops found."
                });
            }

            const historicalSpeedMap =
                await getHistoricalSpeeds(routeVehicles, patterns);

            let vehicles = routeVehicles.map(vehicle =>
                addRouteProgress(
                    vehicle,
                    patterns,
                    historicalSpeedMap.get(
                        String(vehicle.vehicleId)
                    ) ?? null
                )
            );

            const unmatchedVehicles = vehicles.filter(
                vehicle => !vehicle.routeProgress.matched
            );

            if (unmatchedVehicles.length) {
                const alternativeCandidates =
                    await findAlternativeRouteCandidates(
                        unmatchedVehicles
                    );

                vehicles = vehicles.map(vehicle => {
                    if (vehicle.routeProgress.matched) {
                        return vehicle;
                    }

                    const key = String(
                        vehicle.vehicleId ||
                        `${vehicle.tripId}:${vehicle.latitude}:${vehicle.longitude}`
                    );

                    return {
                        ...vehicle,
                        routeMismatch:
                            alternativeCandidates.get(key) || {
                                status: "diagnostic-unavailable",
                                declaredRouteId: String(vehicle.routeId),
                                candidates: []
                            }
                    };
                });
            }

            const matchedVehicles = vehicles.filter(
                vehicle => vehicle.routeProgress.matched
            );

            const directionSummary = {};

            for (const vehicle of vehicles) {
                const key =
                    vehicle.directionId === null ||
                    vehicle.directionId === undefined
                        ? "unknown"
                        : String(vehicle.directionId);

                if (!directionSummary[key]) {
                    directionSummary[key] = {
                        total: 0,
                        matched: 0,
                        unmatched: 0
                    };
                }

                directionSummary[key].total++;

                if (vehicle.routeProgress.matched) {
                    directionSummary[key].matched++;
                } else {
                    directionSummary[key].unmatched++;
                }
            }

            res.json({
                success: true,
                routeId,

                totalVehicles: vehicles.length,
                matchedVehicles: matchedVehicles.length,
                unmatchedVehicles:
                    vehicles.length - matchedVehicles.length,

                availablePatterns: patterns.map(pattern => ({
                    shapeId: pattern.shapeId,
                    directionId: pattern.directionId,
                    representativeStaticTripId:
                        pattern.trip.tripId,
                    tripHeadsign:
                        pattern.trip.tripHeadsign || null,
                    staticTripCount: pattern.tripsById.size,
                    hasCommonStopSequence:
                        pattern.hasCommonStopSequence
                })),

                directionSummary,
                vehicles
            });

        } catch (error) {
            console.error("Route Progress Error:", error);

            res.status(500).json({
                success: false,
                message: "Unable to calculate route progress",
                error: error.message
            });
        }
    }
);

// --------------------------------------------------
// GET LIVE VEHICLES WITH NEAREST GTFS STOP
// --------------------------------------------------

router.get(
    "/vehicles/nearest-stops",
    async (req, res) => {
        try {
            const data = await getLiveVehicles();

            const vehicles = data.vehicles.map(addVehicleStatus);

            const routeIds = [
                ...new Set(
                    vehicles
                        .map(vehicle => String(vehicle.routeId || ""))
                        .filter(Boolean)
                )
            ];

            const trips = await Trip.find({
                routeId: { $in: routeIds }
            })
                .select("tripId routeId")
                .lean();

            const tripById = new Map(
                trips.map(trip => [String(trip.tripId), trip])
            );

            const allTripIds = trips.map(trip => trip.tripId);

            const stopTimes = await StopTime.find({
                tripId: { $in: allTripIds }
            }).lean();

            const stopIds = [
                ...new Set(
                    stopTimes.map(item => String(item.stopId))
                )
            ];

            const stops = await Stop.find({
                stopId: { $in: stopIds }
            }).lean();

            const stopMap = new Map(
                stops.map(stop => [String(stop.stopId), stop])
            );

            const stopTimesByRoute = new Map();

            for (const stopTime of stopTimes) {
                const trip = tripById.get(String(stopTime.tripId));

                if (!trip) continue;

                const routeKey = String(trip.routeId);

                if (!stopTimesByRoute.has(routeKey)) {
                    stopTimesByRoute.set(routeKey, []);
                }

                stopTimesByRoute.get(routeKey).push(stopTime);
            }

            const results = vehicles.map(vehicle => {
                const routeKey = String(vehicle.routeId || "");
                const routeStopTimes =
                    stopTimesByRoute.get(routeKey) || [];

                if (
                    !isValidCoordinate(
                        vehicle.latitude,
                        vehicle.longitude
                    ) ||
                    !routeStopTimes.length
                ) {
                    return {
                        ...vehicle,
                        nearestStop: null
                    };
                }

                let nearest = null;

                for (const time of routeStopTimes) {
                    const stop = stopMap.get(String(time.stopId));

                    if (!stop) continue;

                    const stopLat = Number(stop.stopLat);
                    const stopLon = Number(stop.stopLon);

                    if (
                        !Number.isFinite(stopLat) ||
                        !Number.isFinite(stopLon)
                    ) {
                        continue;
                    }

                    const distance = getDistance(
                        Number(vehicle.latitude),
                        Number(vehicle.longitude),
                        stopLat,
                        stopLon
                    );

                    if (!nearest || distance < nearest.distance) {
                        nearest = {
                            stop,
                            time,
                            distance
                        };
                    }
                }

                return {
                    ...vehicle,

                    nearestStop: nearest
                        ? {
                            stopId: nearest.stop.stopId,
                            stopName: nearest.stop.stopName,
                            distanceMetres: Math.round(nearest.distance),
                            stopSequence: nearest.time.stopSequence,
                            matchedTripId: nearest.time.tripId
                        }
                        : null
                };
            });

            res.json({
                success: true,
                count: results.length,
                vehicles: results
            });

        } catch (error) {
            console.error("Nearest Stops Error:", error.message);

            res.status(500).json({
                success: false,
                message: "Unable to calculate nearest stops",
                error: error.message
            });
        }
    }
);

module.exports = router;
