const fs = require("fs");
const csv = require("csv-parser");

const trips = new Map();

fs.createReadStream("data/gtfs/delhi_buses_static_gtfs_v1/trips.txt")
  .pipe(csv())
  .on("data", row => {
    if (!["1064", "1065"].includes(row.route_id)) return;
    trips.set(row.trip_id, {
      route: row.route_id,
      shape: row.shape_id,
      type: row.trip_id.includes("_SHORT_") ? "SHORT" : "FULL"
    });
  })
  .on("end", () => {
    const selected = new Map();

    fs.createReadStream("data/gtfs/delhi_buses_static_gtfs_v1/stop_times.txt")
      .pipe(csv())
      .on("data", row => {
        const trip = trips.get(row.trip_id);
        if (!trip) return;

        if (!selected.has(row.trip_id)) {
          selected.set(row.trip_id, {
            ...trip,
            tripId: row.trip_id,
            count: 0,
            first: null,
            last: null
          });
        }

        const item = selected.get(row.trip_id);
        const stop = {
          id: row.stop_id,
          sequence: Number(row.stop_sequence)
        };

        item.count++;

        if (!item.first || stop.sequence < item.first.sequence) item.first = stop;
        if (!item.last || stop.sequence > item.last.sequence) item.last = stop;
      })
      .on("end", () => {
        const output = [...selected.values()]
          .filter(x => ["1064_FULL_06_07", "1064_SHORT_06_43", "1065_FULL_07_55"].includes(x.tripId));

        console.log(JSON.stringify(output, null, 2));
      });
  });
