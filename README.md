# 🚌 TransportStack
### Smart Public Transport Journey Planner & Real-Time Bus Tracking Platform

**Plan Smarter. Travel Better. Stay Connected.**

TransportStack is a smart public transportation platform designed to make everyday bus travel easier, more accessible, and more predictable. It helps commuters discover journey options, compare routes, visualize journeys on an interactive map, locate nearby bus stops, and monitor real-time bus movement.

Built with a focus on practical urban mobility challenges, TransportStack aims to bridge the gap between journey planning and live public transport information.

---

## 🌟 Key Features

### 🧭 1. Smart Journey Planner
- Select source and destination locations.
- Search for available public transport journeys.
- Explore multiple route alternatives.
- Compare journey duration, timings, stops, and transfers.
- Make informed travel decisions using route information.

### 🗺️ 2. Interactive Route Visualization
- View selected journeys on an interactive map.
- Understand route paths and stop locations visually.
- Explore geographical relationships between stops and routes.

### 📍 3. Real-Time Bus Tracking
- Monitor available buses through live vehicle information.
- Visualize vehicle positions on the map.
- Track vehicle progress along its assigned route.
- Access route progress and estimated arrival information where available.

### 🚏 4. Nearest Bus Stops
- Discover nearby bus stops.
- Explore stop-related information.
- Make it easier to identify accessible boarding points.

### 📊 5. GTFS-Based Transport Data
- Uses General Transit Feed Specification (GTFS) datasets.
- Processes routes, stops, trips, stop times, and route shapes.
- Supports route and geographical data mapping.
- Includes historical route validation and analysis.

---

## 🛠️ Technology Stack

| Layer | Technologies |
|---|---|
| Backend | Node.js, Express.js |
| Database | MongoDB, Mongoose |
| Frontend | EJS, HTML, CSS, JavaScript |
| Transport Data | GTFS |
| Maps | Interactive map integration |
| Development | Git, GitHub, REST APIs |

---

## ⚙️ Project Architecture

TransportStack follows a modular backend architecture:

- **Routes:** Handle application endpoints and API requests.
- **Controllers:** Manage GTFS and route-related operations.
- **Models:** Represent agencies, routes, stops, trips, shapes, and vehicle history.
- **Services:** Handle GTFS importing, route shapes, and real-time tracking logic.
- **Views:** Provide the Journey Planner, Live Tracking, Nearest Stops, and map interfaces.

---

## 🚀 Getting Started

### Prerequisites
- Node.js and npm
- MongoDB
- Git

### 1. Clone the repository

```bash
git clone https://github.com/prashant9956/TransportStack.git
```

### 2. Navigate to the project

```bash
cd TransportStack
```

### 3. Install dependencies

```bash
npm install
```

### 4. Configure environment variables

Create a `.env` file in the project root and configure the database connection and other required application settings.

Never upload your `.env` file or private credentials to GitHub.

### 5. Import transport datasets

Place the required GTFS dataset in the appropriate data directory and use the project's GTFS import functionality to process the transport data.

**Note:** Large raw GTFS files may need to be downloaded or supplied separately because GitHub has a 100 MB individual file limit.

### 6. Start the application

Run the start command configured in `package.json`.

---

## 📁 Project Structure

```text
TransportStack/
│
├── data/
│   ├── analytics/
│   └── gtfs/
│
├── src/
│   ├── config/
│   ├── controllers/
│   ├── models/
│   ├── routes/
│   ├── scripts/
│   └── services/
│
├── views/
│   ├── journeyPlanner.ejs
│   ├── liveMap.ejs
│   ├── nearestStops.ejs
│   └── tripMap.ejs
│
├── app.js
├── package.json
├── package-lock.json
└── .gitignore
```

---

## 🎯 Project Objective

Urban commuters often face difficulties understanding available bus routes, comparing journey alternatives, locating nearby stops, and accessing reliable vehicle movement information.

TransportStack addresses these challenges through a unified platform that combines journey discovery, route visualization, and real-time public transport tracking.

The goal is to make public transportation information easier to understand and more convenient to access.

---

## 🔮 Future Scope

- Improved real-time arrival predictions.
- Expanded public transport network coverage.
- More advanced route optimization.
- Better accessibility and mobile experience.
- Additional transit data integrations.
- Improved service reliability through historical data analysis.

---

## 👨‍💻 Developed By

**Prashant Singh**

Computer Science & Engineering

GitHub: [@prashant9956](https://github.com/prashant9956)

---

## 📌 Project Information

**Project Name:** TransportStack

**Category:** Smart Mobility / Public Transportation

**Focus Areas:** Journey Planning, GTFS Data Processing, Route Visualization, Real-Time Bus Tracking

**Repository:** [TransportStack on GitHub](https://github.com/prashant9956/TransportStack)

---

*TransportStack — Making Public Transport Smarter and More Accessible.*
