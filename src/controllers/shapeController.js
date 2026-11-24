
const Trip = require("../models/trip");
const Route = require("../models/route");
const Stop = require("../models/stop");
const StopTime = require("../models/stopTime");
const Shape = require("../models/shape");

const getTripShape = async (req, res) => {
    try {
        const { tripId } = req.params;

        // 1. Find trip
        const trip = await Trip.findOne({ tripId }).lean();

        if (!trip) {
            return res.status(404).json({
                success: false,
                message: "Trip not found"
            });
        }

        if (!trip.shapeId) {
            return res.status(404).json({
                success: false,
                message: "Shape ID not available for this trip"
            });
        }

        // 2. Fetch shape points, route and stop times
        const [shapePoints, route, stopTimes] = await Promise.all([
            Shape.find({ shapeId: trip.shapeId })
                .select("shapeId shapePtLat shapePtLon shapePtSequence")
                .sort({ shapePtSequence: 1 })
                .lean(),

            Route.findOne({ routeId: trip.routeId }).lean(),

            StopTime.find({ tripId: trip.tripId })
                .select("stopId arrivalTime departureTime stopSequence")
                .sort({ stopSequence: 1 })
                .lean()
        ]);

        if (!shapePoints.length) {
            return res.status(404).json({
                success: false,
                message: "No shape coordinates found"
            });
        }

        // 3. Fetch stop details
        const stopIds = [
            ...new Set(stopTimes.map(item => item.stopId))
        ];

        const stops = await Stop.find({
            stopId: { $in: stopIds }
        })
            .select("stopId stopName stopLat stopLon")
            .lean();

        const stopMap = new Map(
            stops.map(stop => [stop.stopId, stop])
        );

        const orderedStops = stopTimes.map(item => {
            const stop = stopMap.get(item.stopId);

            if (!stop) return null;

            return {
                stopId: stop.stopId,
                stopName: stop.stopName,
                latitude: stop.stopLat,
                longitude: stop.stopLon,
                stopSequence: item.stopSequence,
                arrivalTime: item.arrivalTime,
                departureTime: item.departureTime
            };
        }).filter(Boolean);

        // 4. Prepare map coordinates [latitude, longitude]
        const coordinates = shapePoints.map(point => [
            point.shapePtLat,
            point.shapePtLon
        ]);

        // 5. Send response
        return res.status(200).json({
            success: true,
            trip: {
                tripId: trip.tripId,
                routeId: trip.routeId,
                serviceId: trip.serviceId,
                tripHeadsign: trip.tripHeadsign,
                directionId: trip.directionId,
                shapeId: trip.shapeId
            },
            route: route || null,
            totalShapePoints: shapePoints.length,
            totalStops: orderedStops.length,
            coordinates,
            stops: orderedStops
        });

    } catch (error) {
        console.error("Trip Shape API Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to fetch trip shape",
            error: error.message
        });
    }
};

module.exports = { getTripShape };
