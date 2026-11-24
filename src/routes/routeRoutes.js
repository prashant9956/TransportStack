
const express = require("express");
const router = express.Router();

const Route = require("../models/route");
const Stop = require("../models/stop");
const StopTime = require("../models/stopTime");
const Trip = require("../models/trip");
const Service = require("../models/service");
const ServiceException = require("../models/serviceException");

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const MAX_TRANSFER_STOPS = 150;
const MAX_JOURNEYS = 100;
const MAX_CANDIDATE_JOURNEYS = 5000;
const MAX_SECOND_LEG_CANDIDATES = 5000;
const MAX_THIRD_LEG_BOARDINGS = 30000;

const MIN_TRANSFER_MINUTES = 5;
const MAX_TRANSFER_MINUTES = 90;

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

const escapeRegex = (value) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const timeToSeconds = (time) => {
    if (!time || typeof time !== "string") return null;

    const parts = time.split(":").map(Number);

    if (
        parts.length !== 3 ||
        parts.some((part) => !Number.isInteger(part) || part < 0) ||
        parts[1] > 59 ||
        parts[2] > 59
    ) {
        return null;
    }

    return parts[0] * 3600 + parts[1] * 60 + parts[2];
};

const calculateDuration = (departure, arrival) => {
    const start = timeToSeconds(departure);
    const end = timeToSeconds(arrival);

    if (start === null || end === null || end < start) return null;

    return Math.round((end - start) / 60);
};

const getTodayIndia = () => {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());

    const values = {};

    for (const part of parts) {
        values[part.type] = part.value;
    }

    return `${values.year}-${values.month}-${values.day}`;
};

const isValidDate = (date) => {
    if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) {
        return false;
    }

    const parsed = new Date(`${date}T00:00:00Z`);

    return (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === date
    );
};

const dateToGTFS = (date) => date.replace(/-/g, "");

const getWeekday = (date) => {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();

    return [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday"
    ][day];
};

const getDeparture = (stopTime) =>
    stopTime.departureTime || stopTime.arrivalTime || null;

const getArrival = (stopTime) =>
    stopTime.arrivalTime || stopTime.departureTime || null;

const getRouteName = (route) => {
    if (!route) return null;

    return (
        route.routeShortName ||
        route.routeLongName ||
        route.routeId
    );
};

const compareTimes = (a, b) => {
    const first = timeToSeconds(a);
    const second = timeToSeconds(b);

    if (first === null && second === null) return 0;
    if (first === null) return 1;
    if (second === null) return -1;

    return first - second;
};

function buildStop(stop) {
    return {
        stopId: stop.stopId,
        stopName: stop.stopName,

        ...(stop.stopLat !== undefined
            ? { latitude: stop.stopLat }
            : {}),

        ...(stop.stopLon !== undefined
            ? { longitude: stop.stopLon }
            : {})
    };
}

function getTransferWaitSeconds(arrivalSeconds, departureSeconds) {
    const wait = departureSeconds - arrivalSeconds;

    if (
        wait < MIN_TRANSFER_MINUTES * 60 ||
        wait > MAX_TRANSFER_MINUTES * 60
    ) {
        return null;
    }

    return wait;
}

function groupBy(items, key) {
    const map = new Map();

    for (const item of items) {
        const value = item[key];

        if (!map.has(value)) {
            map.set(value, []);
        }

        map.get(value).push(item);
    }

    return map;
}

function getDownstreamStopTimes(stopTimes, boarding) {
    return stopTimes.filter((item) =>
        Number(item.stopSequence) >
        Number(boarding.stopSequence)
    );
}

// --------------------------------------------------
// SERVICE DATE VALIDATION
// --------------------------------------------------

async function getActiveServiceIds(date) {
    const gtfsDate = dateToGTFS(date);
    const weekday = getWeekday(date);

    const [services, exceptions] = await Promise.all([
        Service.find({
            startDate: { $lte: gtfsDate },
            endDate: { $gte: gtfsDate },
            [weekday]: true
        })
            .select("serviceId")
            .lean(),

        ServiceException.find({
            exceptionDate: gtfsDate
        })
            .select("serviceId exceptionType")
            .lean()
    ]);

    const activeIds = new Set(
        services.map((service) => service.serviceId)
    );

    for (const exception of exceptions) {
        if (Number(exception.exceptionType) === 1) {
            activeIds.add(exception.serviceId);
        } else if (Number(exception.exceptionType) === 2) {
            activeIds.delete(exception.serviceId);
        }
    }

    return [...activeIds];
}

// --------------------------------------------------
// LOAD ACTIVE TRIPS AND ROUTES
// --------------------------------------------------

async function loadActiveTrips(tripIds, activeServiceIds) {
    if (!tripIds.length || !activeServiceIds.length) {
        return [];
    }

    return Trip.find({
        tripId: { $in: tripIds },
        serviceId: { $in: activeServiceIds }
    }).lean();
}

async function loadRoutes(trips) {
    const routeIds = [
        ...new Set(
            trips.map((trip) => trip.routeId).filter(Boolean)
        )
    ];

    if (!routeIds.length) return new Map();

    const routes = await Route.find({
        routeId: { $in: routeIds }
    }).lean();

    return new Map(
        routes.map((route) => [route.routeId, route])
    );
}

async function loadStopMap(stopIds) {
    const ids = [...new Set(stopIds)];

    if (!ids.length) return new Map();

    const stops = await Stop.find({
        stopId: { $in: ids }
    })
        .select("stopId stopName stopLat stopLon")
        .lean();

    return new Map(
        stops.map((stop) => [stop.stopId, stop])
    );
}

// --------------------------------------------------
// FORMAT JOURNEY LEG
// --------------------------------------------------

function formatLeg({
    trip,
    route,
    fromStop,
    toStop,
    departureTime,
    arrivalTime
}) {
    return {
        tripId: trip.tripId,
        routeId: trip.routeId,

        routeName: getRouteName(route),
        routeShortName: route?.routeShortName || null,
        routeLongName: route?.routeLongName || null,

        tripHeadsign: trip.tripHeadsign || null,

        from: buildStop(fromStop),
        to: buildStop(toStop),

        departureTime,
        arrivalTime,

        durationMinutes: calculateDuration(
            departureTime,
            arrivalTime
        ),

        serviceType: "scheduled",
        liveStatus: "not_checked"
    };
}

// --------------------------------------------------
// JOURNEY RANKING
// --------------------------------------------------

function addJourneyMetrics(journey) {
    const legs = journey.legs || [];

    const transfers = Math.max(0, legs.length - 1);

    const waitingMinutes = Number.isFinite(journey.waitingMinutes)
        ? journey.waitingMinutes
        : 0;

    const easiestScore = transfers * 100 + waitingMinutes;

    return {
        ...journey,

        transfers,
        waitingMinutes,

        ranking: {
            fastestScore: journey.durationMinutes,
            easiestScore,
            reliability: "not_available_without_live_gps"
        }
    };
}


function rankJourneys(journeys) {
    const groupedJourneys = new Map();

    for (const rawJourney of journeys) {
        if (!Number.isFinite(rawJourney.durationMinutes)) {
            continue;
        }

        const journey = addJourneyMetrics(rawJourney);

        // Same route pattern + same transfer stops = one journey option
        const routePattern = journey.legs
            .map((leg) =>
                `${leg.routeId}:${leg.from.stopId}:${leg.to.stopId}`
            )
            .join("|");

        const transferPattern = (journey.transferStops || [])
            .map((stop) => stop.stopId)
            .join("|");

        const key = `${routePattern}|${transferPattern}`;

        if (!groupedJourneys.has(key)) {
            groupedJourneys.set(key, []);
        }

        groupedJourneys.get(key).push(journey);
    }

    // Keep the best departure as primary and preserve other departures
    const all = [...groupedJourneys.values()].map((group) => {
        group.sort((a, b) =>
            a.durationMinutes - b.durationMinutes ||
            a.waitingMinutes - b.waitingMinutes ||
            compareTimes(a.departureTime, b.departureTime)
        );

        const primary = group[0];

        return {
            ...primary,
            alternativeDepartures: group.slice(1).map((alternative) => ({
                journeyId: alternative.journeyId,
                departureTime: alternative.departureTime,
                arrivalTime: alternative.arrivalTime,
                durationMinutes: alternative.durationMinutes,
                waitingMinutes: alternative.waitingMinutes,
                tripIds: alternative.legs.map((leg) => leg.tripId),
                legs: alternative.legs
            }))
        };
    });

    const fastest = [...all].sort((a, b) =>
        a.durationMinutes - b.durationMinutes ||
        a.transfers - b.transfers ||
        compareTimes(a.departureTime, b.departureTime)
    );

    const easiest = [...all].sort((a, b) =>
        a.ranking.easiestScore - b.ranking.easiestScore ||
        a.durationMinutes - b.durationMinutes ||
        compareTimes(a.departureTime, b.departureTime)
    );

    const direct = all.filter((j) => j.transfers === 0);
    const oneTransfer = all.filter((j) => j.transfers === 1);
    const twoTransfer = all.filter((j) => j.transfers === 2);

    const compareDuration = (a, b) =>
        a.durationMinutes - b.durationMinutes ||
        compareTimes(a.departureTime, b.departureTime);

    const selectedById = new Map();

    for (const journey of [
        ...fastest.slice(0, 20),
        ...easiest.slice(0, 20)
    ]) {
        selectedById.set(journey.journeyId, journey);
    }

    for (const category of [direct, oneTransfer, twoTransfer]) {
        const sorted = [...category].sort(compareDuration);

        for (const journey of sorted.slice(0, 10)) {
            selectedById.set(journey.journeyId, journey);
        }
    }

    const selected = [...selectedById.values()]
        .sort(compareDuration)
        .map((journey, index) => ({
            ...journey,
            rank: index + 1,
            fastestRank:
                fastest.findIndex(
                    (item) => item.journeyId === journey.journeyId
                ) + 1,
            easiestRank:
                easiest.findIndex(
                    (item) => item.journeyId === journey.journeyId
                ) + 1
        }));

    return {
        journeys: selected,
        fastest: fastest.slice(0, MAX_JOURNEYS),
        easiest: easiest.slice(0, MAX_JOURNEYS),
        reliability: {
            available: false,
            reason:
                "Live vehicle-to-trip matching and GPS quality are not yet joined to the journey planner. Scheduled data alone cannot establish real-time reliability."
        }
    };
}



// --------------------------------------------------
// 1. GET ALL ROUTES
// --------------------------------------------------

router.get("/", async (req, res) => {
    try {
        const routes = await Route.find().lean();

        return res.json({
            success: true,
            count: routes.length,
            data: routes
        });

    } catch (error) {
        console.error("Get Routes Error:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// --------------------------------------------------
// 2. SEARCH STOPS
// --------------------------------------------------

router.get("/stops", async (req, res) => {
    try {
        const search = typeof req.query.search === "string"
            ? req.query.search.trim()
            : "";

        if (!search) {
            return res.status(400).json({
                success: false,
                message: "Please provide a stop name using ?search="
            });
        }

        const stops = await Stop.find({
            stopName: {
                $regex: escapeRegex(search),
                $options: "i"
            }
        })
            .limit(20)
            .select("stopId stopName stopLat stopLon")
            .lean();

        return res.json({
            success: true,
            count: stops.length,
            data: stops
        });

    } catch (error) {
        console.error("Search Stops Error:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// --------------------------------------------------
// 3. JOURNEY PLANNER
// Direct + One Transfer + Two Transfers
// --------------------------------------------------

router.get("/journey", async (req, res) => {
    try {
        const from = typeof req.query.from === "string"
            ? req.query.from.trim()
            : "";

        const to = typeof req.query.to === "string"
            ? req.query.to.trim()
            : "";

        const date = typeof req.query.date === "string" && req.query.date
            ? req.query.date
            : getTodayIndia();

        const afterTime = typeof req.query.time === "string"
            ? req.query.time.trim()
            : "";

        if (!from || !to) {
            return res.status(400).json({
                success: false,
                message: "Please provide from and to stop IDs"
            });
        }

        if (from === to) {
            return res.status(400).json({
                success: false,
                message: "Source and destination cannot be the same"
            });
        }

        if (!isValidDate(date)) {
            return res.status(400).json({
                success: false,
                message: "Invalid date. Use YYYY-MM-DD format."
            });
        }

        if (afterTime && timeToSeconds(afterTime) === null) {
            return res.status(400).json({
                success: false,
                message: "Invalid time. Use HH:MM:SS format."
            });
        }

        // --------------------------------------------------
        // 1. FIND SOURCE AND DESTINATION
        // --------------------------------------------------

        const [sourceStop, destinationStop] = await Promise.all([
            Stop.findOne({ stopId: from }).lean(),
            Stop.findOne({ stopId: to }).lean()
        ]);

        if (!sourceStop || !destinationStop) {
            return res.status(404).json({
                success: false,
                message: "Source or destination stop not found"
            });
        }

        // --------------------------------------------------
        // 2. ACTIVE SERVICES
        // --------------------------------------------------

        const activeServiceIds = await getActiveServiceIds(date);

        if (!activeServiceIds.length) {
            return res.json({
                success: true,
                date,
                from: buildStop(sourceStop),
                to: buildStop(destinationStop),
                activeServiceCount: 0,
                count: 0,
                totalCandidatesFound: 0,
                journeyTypes: {
                    direct: 0,
                    oneTransfer: 0,
                    twoTransfer: 0
                },
                journeys: [],
                rankings: {
                    fastest: [],
                    easiest: [],
                    mostReliable: {
                        available: false
                    }
                },
                message: "No bus services operate on this date."
            });
        }

        // --------------------------------------------------
        // 3. SOURCE DEPARTURES
        // --------------------------------------------------

        const allSourceTimes = await StopTime.find({
            stopId: sourceStop.stopId
        })
            .sort({
                departureTime: 1,
                arrivalTime: 1
            })
            .lean();

        if (!allSourceTimes.length) {
            return res.json({
                success: true,
                date,
                from: buildStop(sourceStop),
                to: buildStop(destinationStop),
                activeServiceCount: activeServiceIds.length,
                count: 0,
                totalCandidatesFound: 0,
                journeyTypes: {
                    direct: 0,
                    oneTransfer: 0,
                    twoTransfer: 0
                },
                journeys: [],
                rankings: {
                    fastest: [],
                    easiest: [],
                    mostReliable: {
                        available: false
                    }
                },
                message: "No departures found from this stop."
            });
        }

        // --------------------------------------------------
        // 4. FILTER ACTIVE SOURCE TRIPS
        // --------------------------------------------------

        const allSourceTripIds = [
            ...new Set(allSourceTimes.map((item) => item.tripId))
        ];

        const sourceTrips = await loadActiveTrips(
            allSourceTripIds,
            activeServiceIds
        );

        const sourceTripMap = new Map(
            sourceTrips.map((trip) => [trip.tripId, trip])
        );

        let validSourceTimes = allSourceTimes.filter(
            (item) => sourceTripMap.has(item.tripId)
        );

        if (afterTime) {
            const requestedSeconds = timeToSeconds(afterTime);

            validSourceTimes = validSourceTimes.filter((item) => {
                const departureSeconds = timeToSeconds(
                    getDeparture(item)
                );

                return (
                    departureSeconds !== null &&
                    departureSeconds >= requestedSeconds
                );
            });
        }

        if (!validSourceTimes.length) {
            return res.json({
                success: true,
                date,
                from: buildStop(sourceStop),
                to: buildStop(destinationStop),
                activeServiceCount: activeServiceIds.length,
                count: 0,
                totalCandidatesFound: 0,
                journeyTypes: {
                    direct: 0,
                    oneTransfer: 0,
                    twoTransfer: 0
                },
                journeys: [],
                rankings: {
                    fastest: [],
                    easiest: [],
                    mostReliable: {
                        available: false
                    }
                },
                message: afterTime
                    ? "No active departures found after the requested time."
                    : "No active departures found for this date."
            });
        }

        const journeys = [];

        const directTripIds = [
            ...new Set(validSourceTimes.map((item) => item.tripId))
        ];

        const directRoutes = await loadRoutes(sourceTrips);

        // --------------------------------------------------
        // A. DIRECT JOURNEYS
        // --------------------------------------------------

        const directDestinationTimes = await StopTime.find({
            tripId: { $in: directTripIds },
            stopId: destinationStop.stopId
        }).lean();

        const directDestinationMap = groupBy(
            directDestinationTimes,
            "tripId"
        );

        for (const items of directDestinationMap.values()) {
            items.sort(
                (a, b) =>
                    Number(a.stopSequence) -
                    Number(b.stopSequence)
            );
        }

        for (const sourceTime of validSourceTimes) {
            const trip = sourceTripMap.get(sourceTime.tripId);

            if (!trip) continue;

            const departureTime = getDeparture(sourceTime);
            const departureSeconds = timeToSeconds(departureTime);

            if (departureSeconds === null) continue;

            const destinations =
                directDestinationMap.get(sourceTime.tripId) || [];

            const destinationTime = destinations.find((item) =>
                Number(item.stopSequence) >
                Number(sourceTime.stopSequence)
            );

            if (!destinationTime) continue;

            const arrivalTime = getArrival(destinationTime);

            const arrivalSeconds = timeToSeconds(arrivalTime);

            if (
                arrivalSeconds === null ||
                arrivalSeconds <= departureSeconds
            ) {
                continue;
            }

            const durationMinutes = calculateDuration(
                departureTime,
                arrivalTime
            );

            if (durationMinutes === null) continue;

            const leg = formatLeg({
                trip,
                route: directRoutes.get(trip.routeId),
                fromStop: sourceStop,
                toStop: destinationStop,
                departureTime,
                arrivalTime
            });

            journeys.push({
                journeyId:
                    `direct:${trip.tripId}:${sourceStop.stopId}:${destinationStop.stopId}`,

                type: "direct",
                transfers: 0,

                departureTime,
                arrivalTime,
                durationMinutes,

                waitingMinutes: 0,
                legs: [leg]
            });
        }

        // --------------------------------------------------
        // B. FIRST-LEG TRANSFER CANDIDATES
        // --------------------------------------------------

        const firstLegStopTimes = await StopTime.find({
            tripId: { $in: directTripIds }
        })
            .sort({
                tripId: 1,
                stopSequence: 1
            })
            .lean();

        const sourceTimesByTrip = groupBy(
            validSourceTimes,
            "tripId"
        );

        const transferCandidates = [];

        for (const stopTime of firstLegStopTimes) {
            if (
                stopTime.stopId === sourceStop.stopId ||
                stopTime.stopId === destinationStop.stopId
            ) {
                continue;
            }

            const trip = sourceTripMap.get(stopTime.tripId);

            if (!trip) continue;

            const possibleSourceTimes =
                sourceTimesByTrip.get(stopTime.tripId) || [];

            const sourceTime = possibleSourceTimes.find((item) =>
                Number(item.stopSequence) <
                Number(stopTime.stopSequence)
            );

            if (!sourceTime) continue;

            const departureTime = getDeparture(sourceTime);
            const transferArrivalTime = getArrival(stopTime);

            const departureSeconds = timeToSeconds(departureTime);
            const arrivalSeconds = timeToSeconds(transferArrivalTime);

            if (
                departureSeconds === null ||
                arrivalSeconds === null ||
                arrivalSeconds <= departureSeconds
            ) {
                continue;
            }

            transferCandidates.push({
                trip,
                sourceTime,
                transferTime: stopTime,
                departureTime,
                transferArrivalTime,
                departureSeconds,
                arrivalSeconds
            });
        }

        transferCandidates.sort((a, b) =>
            a.arrivalSeconds - b.arrivalSeconds ||
            a.departureSeconds - b.departureSeconds
        );

        const selectedTransferCandidates =
            transferCandidates.slice(0, MAX_CANDIDATE_JOURNEYS);

        const uniqueTransferStops = [
            ...new Set(
                selectedTransferCandidates.map(
                    (item) => item.transferTime.stopId
                )
            )
        ].slice(0, MAX_TRANSFER_STOPS);

        const allowedFirstTransferStops = new Set(
            uniqueTransferStops
        );

        // --------------------------------------------------
        // C. LOAD SECOND-LEG BOARDINGS
        // --------------------------------------------------

        if (uniqueTransferStops.length) {
            const secondLegBoardings = await StopTime.find({
                stopId: { $in: uniqueTransferStops }
            })
                .sort({
                    stopId: 1,
                    departureTime: 1,
                    arrivalTime: 1
                })
                .lean();

            const secondTripIds = [
                ...new Set(
                    secondLegBoardings.map((item) => item.tripId)
                )
            ];

            const secondTrips = await loadActiveTrips(
                secondTripIds,
                activeServiceIds
            );

            const secondTripMap = new Map(
                secondTrips.map((trip) => [trip.tripId, trip])
            );

            const validSecondTripIds = secondTrips.map(
                (trip) => trip.tripId
            );

            const secondRoutes = await loadRoutes(secondTrips);

            const secondStopTimes = validSecondTripIds.length
                ? await StopTime.find({
                    tripId: { $in: validSecondTripIds }
                })
                    .sort({
                        tripId: 1,
                        stopSequence: 1
                    })
                    .lean()
                : [];

            const secondStopTimesByTrip = groupBy(
                secondStopTimes,
                "tripId"
            );

            const secondBoardingsByStop = groupBy(
                secondLegBoardings.filter((item) =>
                    secondTripMap.has(item.tripId)
                ),
                "stopId"
            );

            const firstTransferStopMap = await loadStopMap(
                uniqueTransferStops
            );

            // Each valid second-leg boarding can lead to:
            // 1. Destination directly (one transfer).
            // 2. Another transfer stop (two transfers).

            const secondLegCandidates = [];

            // --------------------------------------------------
            // D. BUILD ONE-TRANSFER AND SECOND-TRANSFER OPTIONS
            // --------------------------------------------------

            for (const firstCandidate of selectedTransferCandidates) {
                const firstTransferStopId =
                    firstCandidate.transferTime.stopId;

                if (!allowedFirstTransferStops.has(firstTransferStopId)) {
                    continue;
                }

                const firstTransferStop =
                    firstTransferStopMap.get(firstTransferStopId);

                if (!firstTransferStop) continue;

                const possibleBoardings =
                    secondBoardingsByStop.get(firstTransferStopId) || [];

                for (const boarding of possibleBoardings) {
                    if (
                        boarding.tripId === firstCandidate.trip.tripId
                    ) {
                        continue;
                    }

                    const secondTrip =
                        secondTripMap.get(boarding.tripId);

                    if (!secondTrip) continue;

                    const secondDeparture = getDeparture(boarding);
                    const secondDepartureSeconds =
                        timeToSeconds(secondDeparture);

                    if (secondDepartureSeconds === null) continue;

                    const firstWaitSeconds = getTransferWaitSeconds(
                        firstCandidate.arrivalSeconds,
                        secondDepartureSeconds
                    );

                    if (firstWaitSeconds === null) continue;

                    const secondTripStops =
                        secondStopTimesByTrip.get(boarding.tripId) || [];

                    const downstreamStops = getDownstreamStopTimes(
                        secondTripStops,
                        boarding
                    );

                    if (!downstreamStops.length) continue;

                    for (const downstreamStop of downstreamStops) {
                        const secondArrivalTime =
                            getArrival(downstreamStop);

                        const secondArrivalSeconds =
                            timeToSeconds(secondArrivalTime);

                        if (
                            secondArrivalSeconds === null ||
                            secondArrivalSeconds <= secondDepartureSeconds
                        ) {
                            continue;
                        }

                        // ------------------------------------------
                        // ONE-TRANSFER: SECOND BUS REACHES DESTINATION
                        // ------------------------------------------

                        if (
                            downstreamStop.stopId ===
                            destinationStop.stopId
                        ) {
                            const totalDuration = calculateDuration(
                                firstCandidate.departureTime,
                                secondArrivalTime
                            );

                            if (totalDuration === null) continue;

                            const firstLeg = formatLeg({
                                trip: firstCandidate.trip,
                                route: directRoutes.get(
                                    firstCandidate.trip.routeId
                                ),
                                fromStop: sourceStop,
                                toStop: firstTransferStop,
                                departureTime: firstCandidate.departureTime,
                                arrivalTime: firstCandidate.transferArrivalTime
                            });

                            const secondLeg = formatLeg({
                                trip: secondTrip,
                                route: secondRoutes.get(secondTrip.routeId),
                                fromStop: firstTransferStop,
                                toStop: destinationStop,
                                departureTime: secondDeparture,
                                arrivalTime: secondArrivalTime
                            });

                            journeys.push({
                                journeyId:
                                    `transfer:${firstCandidate.trip.tripId}:${secondTrip.tripId}:${firstTransferStopId}`,

                                type: "transfer",
                                transfers: 1,

                                departureTime: firstCandidate.departureTime,
                                arrivalTime: secondArrivalTime,
                                durationMinutes: totalDuration,

                                waitingMinutes: Math.round(
                                    firstWaitSeconds / 60
                                ),

                                transferStop: buildStop(firstTransferStop),

                                legs: [
                                    firstLeg,
                                    secondLeg
                                ]
                            });

                            continue;
                        }

                        // ------------------------------------------
                        // SECOND TRANSFER CANDIDATE
                        // ------------------------------------------

                        if (
                            downstreamStop.stopId === sourceStop.stopId ||
                            downstreamStop.stopId === firstTransferStopId
                        ) {
                            continue;
                        }

                        secondLegCandidates.push({
                            firstCandidate,

                            firstTransferStop,

                            secondTrip,
                            secondBoarding: boarding,

                            secondTransferTime: downstreamStop,

                            secondDeparture,
                            secondArrivalTime,

                            secondDepartureSeconds,
                            secondArrivalSeconds,

                            firstWaitSeconds
                        });
                    }
                }
            }

            // --------------------------------------------------
            // E. LIMIT SECOND-TRANSFER EXPANSION
            // --------------------------------------------------

            secondLegCandidates.sort((a, b) =>
                a.secondArrivalSeconds - b.secondArrivalSeconds ||
                a.firstCandidate.departureSeconds -
                    b.firstCandidate.departureSeconds
            );

            const selectedSecondLegCandidates =
                secondLegCandidates.slice(
                    0,
                    MAX_SECOND_LEG_CANDIDATES
                );

            const secondTransferStopIds = [
                ...new Set(
                    selectedSecondLegCandidates.map(
                        (item) => item.secondTransferTime.stopId
                    )
                )
            ].slice(0, MAX_TRANSFER_STOPS);

            const allowedSecondTransferStops = new Set(
                secondTransferStopIds
            );

            // --------------------------------------------------
            // F. FIND THIRD-LEG BOARDINGS
            // --------------------------------------------------

            if (secondTransferStopIds.length) {
                const thirdLegBoardings = await StopTime.find({
                    stopId: {
                        $in: secondTransferStopIds
                    }
                })
                    .sort({
                        stopId: 1,
                        departureTime: 1,
                        arrivalTime: 1
                    })
                    .limit(MAX_THIRD_LEG_BOARDINGS)
                    .lean();

                const thirdTripIds = [
                    ...new Set(
                        thirdLegBoardings.map((item) => item.tripId)
                    )
                ];

                const thirdTrips = await loadActiveTrips(
                    thirdTripIds,
                    activeServiceIds
                );

                const thirdTripMap = new Map(
                    thirdTrips.map((trip) => [trip.tripId, trip])
                );

                const validThirdTripIds = thirdTrips.map(
                    (trip) => trip.tripId
                );

                const thirdRoutes = await loadRoutes(thirdTrips);

                // ----------------------------------------------
                // DESTINATION TIMES FOR THIRD-LEG TRIPS
                // ----------------------------------------------

                const thirdDestinationTimes = validThirdTripIds.length
                    ? await StopTime.find({
                        tripId: {
                            $in: validThirdTripIds
                        },
                        stopId: destinationStop.stopId
                    }).lean()
                    : [];

                const thirdDestinationMap = groupBy(
                    thirdDestinationTimes,
                    "tripId"
                );

                for (const items of thirdDestinationMap.values()) {
                    items.sort(
                        (a, b) =>
                            Number(a.stopSequence) -
                            Number(b.stopSequence)
                    );
                }

                const thirdBoardingsByStop = groupBy(
                    thirdLegBoardings.filter((item) =>
                        thirdTripMap.has(item.tripId)
                    ),
                    "stopId"
                );

                const secondTransferStopMap = await loadStopMap(
                    secondTransferStopIds
                );

                // ----------------------------------------------
                // BUILD THREE-BUS JOURNEYS
                // ----------------------------------------------

                for (const candidate of selectedSecondLegCandidates) {
                    const secondTransferStopId =
                        candidate.secondTransferTime.stopId;

                    if (
                        !allowedSecondTransferStops.has(
                            secondTransferStopId
                        )
                    ) {
                        continue;
                    }

                    const secondTransferStop =
                        secondTransferStopMap.get(secondTransferStopId);

                    if (!secondTransferStop) continue;

                    const possibleThirdBoardings =
                        thirdBoardingsByStop.get(secondTransferStopId) || [];

                    for (const thirdBoarding of possibleThirdBoardings) {
                        // Do not reuse either of the previous buses.
                        if (
                            thirdBoarding.tripId ===
                                candidate.firstCandidate.trip.tripId ||
                            thirdBoarding.tripId ===
                                candidate.secondTrip.tripId
                        ) {
                            continue;
                        }

                        const thirdTrip =
                            thirdTripMap.get(thirdBoarding.tripId);

                        if (!thirdTrip) continue;

                        const thirdDeparture =
                            getDeparture(thirdBoarding);

                        const thirdDepartureSeconds =
                            timeToSeconds(thirdDeparture);

                        if (thirdDepartureSeconds === null) continue;

                        const secondWaitSeconds = getTransferWaitSeconds(
                            candidate.secondArrivalSeconds,
                            thirdDepartureSeconds
                        );

                        if (secondWaitSeconds === null) continue;

                        const destinationOptions =
                            thirdDestinationMap.get(thirdBoarding.tripId) || [];

                        const destinationTime = destinationOptions.find(
                            (item) =>
                                Number(item.stopSequence) >
                                Number(thirdBoarding.stopSequence)
                        );

                        if (!destinationTime) continue;

                        const finalArrivalTime =
                            getArrival(destinationTime);

                        const finalArrivalSeconds =
                            timeToSeconds(finalArrivalTime);

                        if (
                            finalArrivalSeconds === null ||
                            finalArrivalSeconds <= thirdDepartureSeconds
                        ) {
                            continue;
                        }

                        const totalDuration = calculateDuration(
                            candidate.firstCandidate.departureTime,
                            finalArrivalTime
                        );

                        if (totalDuration === null) continue;

                        const firstLeg = formatLeg({
                            trip: candidate.firstCandidate.trip,

                            route: directRoutes.get(
                                candidate.firstCandidate.trip.routeId
                            ),

                            fromStop: sourceStop,
                            toStop: candidate.firstTransferStop,

                            departureTime:
                                candidate.firstCandidate.departureTime,

                            arrivalTime:
                                candidate.firstCandidate.transferArrivalTime
                        });

                        const secondLeg = formatLeg({
                            trip: candidate.secondTrip,

                            route: secondRoutes.get(
                                candidate.secondTrip.routeId
                            ),

                            fromStop: candidate.firstTransferStop,
                            toStop: secondTransferStop,

                            departureTime: candidate.secondDeparture,
                            arrivalTime: candidate.secondArrivalTime
                        });

                        const thirdLeg = formatLeg({
                            trip: thirdTrip,

                            route: thirdRoutes.get(thirdTrip.routeId),

                            fromStop: secondTransferStop,
                            toStop: destinationStop,

                            departureTime: thirdDeparture,
                            arrivalTime: finalArrivalTime
                        });

                        const totalWaitingSeconds =
                            candidate.firstWaitSeconds +
                            secondWaitSeconds;

                        journeys.push({
                            journeyId:
                                `two-transfer:${candidate.firstCandidate.trip.tripId}:${candidate.secondTrip.tripId}:${thirdTrip.tripId}:${candidate.firstTransferStop.stopId}:${secondTransferStopId}`,

                            type: "two_transfer",
                            transfers: 2,

                            departureTime:
                                candidate.firstCandidate.departureTime,

                            arrivalTime: finalArrivalTime,

                            durationMinutes: totalDuration,

                            waitingMinutes: Math.round(
                                totalWaitingSeconds / 60
                            ),

                            transferStops: [
                                buildStop(candidate.firstTransferStop),
                                buildStop(secondTransferStop)
                            ],

                            legs: [
                                firstLeg,
                                secondLeg,
                                thirdLeg
                            ]
                        });
                    }
                }
            }
        }

        // --------------------------------------------------
        // FINAL RESPONSE
        // --------------------------------------------------
  


        // --------------------------------------------------
        // FINAL RESPONSE
        // --------------------------------------------------

        const ranked = rankJourneys(journeys);

        const journeyTypes = {
            direct: journeys.filter(
                (item) => item.transfers === 0
            ).length,

            oneTransfer: journeys.filter(
                (item) => item.transfers === 1
            ).length,

            twoTransfer: journeys.filter(
                (item) => item.transfers === 2
            ).length
        };
        return res.json({
            success: true,

            date,
            requestedTime: afterTime || null,

            from: buildStop(sourceStop),
            to: buildStop(destinationStop),

            activeServiceCount: activeServiceIds.length,

            count: ranked.journeys.length,

            totalCandidatesFound: journeys.length,

            journeyTypes,

            rankingInfo: {
                defaultOrder: "fastest",

                fastest: "Scheduled total journey duration",

                easiest:
                    "Transfer count first, then scheduled waiting time",

                reliability: ranked.reliability
            },

            rankings: {
                fastest: ranked.fastest
                    .slice(0, MAX_JOURNEYS)
                    .map((item, index) => ({
                        journeyId: item.journeyId,
                        rank: index + 1,
                        durationMinutes: item.durationMinutes,
                        transfers: item.transfers
                    })),

                easiest: ranked.easiest
                    .slice(0, MAX_JOURNEYS)
                    .map((item, index) => ({
                        journeyId: item.journeyId,
                        rank: index + 1,
                        durationMinutes: item.durationMinutes,
                        transfers: item.transfers,
                        waitingMinutes: item.waitingMinutes
                    })),

                mostReliable: ranked.reliability
            },

            journeys: ranked.journeys
        });

    } catch (error) {
        console.error("Journey Planner Error:", error);

        return res.status(500).json({
            success: false,
            message: "Journey planning failed",
            error: error.message
        });
    }
});

// --------------------------------------------------
// EXPORT ROUTER
// --------------------------------------------------

module.exports = router;
