/**
 * CityRide Platform - Mobile API Configuration
 * 
 * This file tells the app where the backend server is located.
 */

// [IMPORTANT] Replace this with your actual live Railway project URL (e.g., https://myapp.up.railway.app)
const PRODUCTION_URL = window.location.origin;
// Auto-detect Local vs Production environment
const isLocal = window.location.hostname === "localhost" || 
                window.location.hostname === "127.0.0.1" || 
                window.location.hostname.startsWith("192.168.") || 
                window.location.hostname.startsWith("10.");

const API_BASE_URL = isLocal ? "" : PRODUCTION_URL;

console.log("🚀 CityRide Engine - API Root:", API_BASE_URL || "Local Instance");
