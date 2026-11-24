const fs = require("fs");
const csv = require("csv-parser");

const wanted = new Set([
  "shp_3_3419",
  "shp_3_3418",
  "shp_3_2316"
]);

const shapes = new Map();

fs.createReadStream("data/gtfs/delhi_buses_static_gtfs_v1/shapes.txt")
  .pipe(csv())
  .on("data", row => {
    const id = row.shape_id;
    if (!wanted.has(id)) return;

    if (!shapes.has(id)) shapes.set(id, []);
    shapes.get(id).push({
      lat: Number(row.shape_pt_lat),
      lng: Number(row.shape_pt_lon),
      seq: Number(row.shape_pt_sequence)
    });
  })
  .on("end", () => {
    for (const [id, points] of shapes) {
      points.sort((a, b) => a.seq - b.seq);

      const first = points[0];
      const last = points[points.length - 1];

      console.log("\nSHAPE:", id);
      console.log("Points:", points.length);
      console.log("First:", first);
      console.log("Last:", last);
    }
  });
