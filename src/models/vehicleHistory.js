
const mongoose = require("mongoose");

const vehicleHistorySchema = new mongoose.Schema(
    {
        vehicleId: {
            type: String,
            required: true
        },
        routeId: {
            type: String,
            default: null
        },
        tripId: {
            type: String,
            default: null
        },
        latitude: {
            type: Number,
            required: true
        },
        longitude: {
            type: Number,
            required: true
        },
        speed: {
            type: Number,
            default: null
        },
        speedSource: {
            type: String,
            default: "unavailable"
        },
        bearing: {
            type: Number,
            default: null
        },
        timestamp: {
            type: Date,
            required: true
        }
    },
    {
        timestamps: true,
        collection: "vehiclehistories"
    }
);

// One observation per vehicle per feed timestamp.
vehicleHistorySchema.index(
    { vehicleId: 1, timestamp: 1 },
    { unique: true }
);

// Automatically remove old GPS history after 30 days.
vehicleHistorySchema.index(
    { timestamp: 1 },
    { expireAfterSeconds: 30 * 24 * 60 * 60 }
);

vehicleHistorySchema.index({ vehicleId: 1, timestamp: -1 });
vehicleHistorySchema.index({ routeId: 1, timestamp: -1 });

module.exports = mongoose.model("VehicleHistory", vehicleHistorySchema);
