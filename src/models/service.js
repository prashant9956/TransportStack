const mongoose = require("mongoose");

const serviceSchema = new mongoose.Schema({
    serviceId: {
        type: String,
        required: true,
        unique: true
    },
    monday: { type: Boolean, default: false },
    tuesday: { type: Boolean, default: false },
    wednesday: { type: Boolean, default: false },
    thursday: { type: Boolean, default: false },
    friday: { type: Boolean, default: false },
    saturday: { type: Boolean, default: false },
    sunday: { type: Boolean, default: false },
    startDate: {
        type: String,
        required: true
    },
    endDate: {
        type: String,
        required: true
    }
}, { timestamps: true });

module.exports = mongoose.model("Service", serviceSchema);