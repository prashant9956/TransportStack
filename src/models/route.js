
const mongoose = require("mongoose");

const routeSchema = new mongoose.Schema({
    routeId: {
        type: String,
        required: true,
        unique: true
    },
    agencyId: String,
    routeShortName: String,
    routeLongName: String,
    routeType: Number,
    routeColor: String,
    routeTextColor: String
}, { timestamps: true });

module.exports = mongoose.model("Route", routeSchema);
