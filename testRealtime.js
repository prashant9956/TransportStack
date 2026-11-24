require("dotenv").config();

const axios = require("axios");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

async function testRealtimeFeed() {
    try {
        const apiKey = process.env.OTD_API_KEY;

        const url = `https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb?key=${encodeURIComponent(apiKey)}`;

        console.log("Fetching Delhi live bus data...");

        const response = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 30000
        });

        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
            new Uint8Array(response.data)
        );

        console.log("\nFeed decoded successfully!");
        console.log("Total entities:", feed.entity.length);

        const vehicles = feed.entity.filter(entity => entity.vehicle);

        console.log("Vehicle records:", vehicles.length);

        console.log("\nFirst 3 vehicle records:");

        vehicles.slice(0, 3).forEach(entity => {
            const vehicle = entity.vehicle;

            console.log({
                vehicleId: vehicle.vehicle?.id,
                tripId: vehicle.trip?.tripId,
                latitude: vehicle.position?.latitude,
                longitude: vehicle.position?.longitude,
                speed: vehicle.position?.speed,
                bearing: vehicle.position?.bearing,
                timestamp: vehicle.timestamp
            });
        });

    } catch (error) {
        console.error("Realtime decoding error:", error.message);
    }
}

testRealtimeFeed();