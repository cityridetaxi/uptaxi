/**
 * CityRideTaxi - Main Application Logic
 */

const VEHICLE_ICONS = {
    bike: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 17.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5s-1.12 2.5-2.5 2.5z"/><path d="M18.5 17.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5s-1.12 2.5-2.5 2.5z"/><path d="M10 15h4l2-4h-8z"/><path d="M12 11V7c0-1-1-2-2-2"/><path d="M8 5h4"/></svg>`,
    hatchback: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14l2-6h14l2 6v5c0 .6-.4 1-1 1h-1a1 1 0 0 1-1-1v-1H5v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-5z"/><path d="M5 8V6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v2"/><circle cx="7" cy="14" r="2" fill="currentColor"/><circle cx="17" cy="14" r="2" fill="currentColor"/></svg>`,
    sedan: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2" fill="currentColor"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2" fill="currentColor"/><path d="M14 10V8m-4 2V8"/></svg>`,
    suv: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="10" width="20" height="8" rx="1"/><path d="M4 10V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5"/><circle cx="7" cy="18" r="2" fill="currentColor"/><circle cx="17" cy="18" r="2" fill="currentColor"/><path d="M9 18h6"/></svg>`
};

document.addEventListener('DOMContentLoaded', () => {
    const isLandingPage = window.location.pathname.endsWith('/') || window.location.pathname === '/' || window.location.pathname.endsWith('/');
    const isAuthPage = window.location.pathname.includes('/auth') || window.location.pathname.includes('/login');

    const member = JSON.parse(localStorage.getItem('cityride_member'));
    const pilot = JSON.parse(localStorage.getItem('cityride_pilot'));
    const master = JSON.parse(localStorage.getItem('cityride_master'));

    // 1. Landing Page Logic (Home)
    // We NO LONGER force redirect admins/pilots away from /
    // This allows you to browse the home page even if you have an admin session active.

    // 2. Auth Guard for Landing Page (/)
    // If you are on the landing page and NOT logged in as a passenger, we show login.
    // (Optional: You can remove this if you want / to be public)
    if (isLandingPage && !member && !master && !pilot) {
        window.location.href = '/auth';
        return;
    }

    const bookingForm = document.getElementById('booking-form');
    const passengerInput = document.getElementById('passengers');
    const vehicleSelect = document.getElementById('vehicle-type');
    const fareEstimate = document.getElementById('fare-estimate');
    const distanceVal = document.getElementById('distance-val');
    const fareVal = document.getElementById('fare-val');
    const vehicleBadge = document.getElementById('vehicle-badge');
    const categoryBtns = document.querySelectorAll('.category-btn');
    const destinationGroup = document.getElementById('destination-group');
    const pickupDate = document.getElementById('pickup-date');
    const returnDate = document.getElementById('return-date');
    const returnDateGroup = document.getElementById('return-date-group');
    const rentalPackageGroup = document.getElementById('rental-package-group');
    const rentalPackageSelect = document.getElementById('rental-package');

    // 1. Initialize Date Restrictions (Must be future)
    const today = new Date().toISOString().split('T')[0];
    pickupDate.setAttribute('min', today);
    pickupDate.value = today;

    // Auto-fetch live location on start for all modes
    setTimeout(() => useLiveLocation(null, true), 1000); 

    if (returnDate) {
        returnDate.setAttribute('min', today);
        returnDate.value = today;
    }

    // 2. Service Category Switching
    let currentCategory = 'local'; // 'local', 'outstation', or 'rental'
    categoryBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            categoryBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCategory = btn.dataset.category;

            if (currentCategory === 'rental') {
                destinationGroup.style.display = 'none';
                document.getElementById('drop').required = false;
                rentalPackageGroup.style.display = 'flex';
                returnDateGroup.style.display = 'none';
                
                // Trigger live location fetch (silent)
                useLiveLocation(null, true);

                if (pickupCoords) calculateFare();
            } else {
                destinationGroup.style.display = 'flex';
                document.getElementById('drop').required = true;
                rentalPackageGroup.style.display = 'none';
                returnDateGroup.style.display = 'none';
                
                if (dropCoords) calculateFare();
                else document.getElementById('vehicle-selection-container').innerHTML = '';
            }
        });
    });

    // 3. Logic to handle updates
    if (rentalPackageSelect) rentalPackageSelect.addEventListener('change', calculateFare);
    if (returnDate) returnDate.addEventListener('change', calculateFare);

    let currentTripType = 'oneway'; 

    if (rentalPackageSelect) {
        rentalPackageSelect.addEventListener('change', calculateFare);
    }
    if (returnDate) {
        returnDate.addEventListener('change', calculateFare);
    }

    // Mobile Burger Logic
    const burgerToggle = document.getElementById('burger-toggle');
    const navLinksList = document.querySelector('.nav-links');

    if (burgerToggle && navLinksList) {
        burgerToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            burgerToggle.classList.toggle('active');
            navLinksList.classList.toggle('active');
        });

        // Close menu when clicking a link
        navLinksList.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                burgerToggle.classList.remove('active');
                navLinksList.classList.remove('active');
            });
        });

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!navLinksList.contains(e.target) && !burgerToggle.contains(e.target)) {
                burgerToggle.classList.remove('active');
                navLinksList.classList.remove('active');
            }
        });
    }

    // 3. Passenger Count Change Logic
    if (passengerInput) {
        passengerInput.addEventListener('change', () => {
            calculateFare(); // Refresh vehicle tiles and prices when capacity changes
        });
    }

    // --- Dynamic Tariff Storage ---
    let pricing = null;
    let peakRules = [];

    async function fetchTariffs() {
        try {
            // Fetch Standard Tariffs
            const res = await fetch(`${API_BASE_URL}/api/tariffs`);
            const data = await res.json();
            
            // Fetch Peak Rules
            const peakRes = await fetch(`${API_BASE_URL}/api/peak-rules`);
            peakRules = await peakRes.json();
            console.log('⚡ Dynamic Peak Rules Active:', peakRules);

            // Transform array into nested object structure expected by renderVehicleOptions
            const transformed = {};
            data.forEach(t => {
                if (!transformed[t.vehicle_type]) {
                    // Initialize with display properties (these could also be moved to DB eventually)
                    const displayInfo = {
                        bike: { name: 'Classy Bike Taxi', capacity: '1 Seater', maxPassengers: 1 },
                        hatchback: { name: 'Hatchback', capacity: '3+1 Seater', maxPassengers: 3 },
                        sedan: { name: 'Sedan', capacity: '4+1 Seater', maxPassengers: 4 },
                        suv: { name: 'SUV', capacity: '6+1 Seater', maxPassengers: 6 }
                    };
                    transformed[t.vehicle_type] = { ...displayInfo[t.vehicle_type] };
                }
                transformed[t.vehicle_type][t.category] = typeof t.config === 'string' ? JSON.parse(t.config) : t.config;
            });
            pricing = transformed;
            console.log('✅ Tariffs synchronized with Mainframe.');
        } catch (err) {
            console.error('Tariff fetch failed, using emergency fallback.', err);
            // Fallback to hardcoded values if API fails
            pricing = {
                bike: {
                    name: 'Classy Bike Taxi', capacity: '1 Seater', maxPassengers: 1,
                    local: { base: 0, perKm: 10, minKm: 5 },
                    oneway: { base: 0, perKm: 10, minKm: 5, convenience: 0 }
                },
                hatchback: {
                    name: 'Hatchback', capacity: '3+1 Seater', maxPassengers: 3,
                    local: { base: 150, perKm: 20, minKm: 0 },
                    oneway: { base: 0, perKm: 11, minKm: 100 },
                    round: { base: 0, perKm: 10, minKmPerDay: 200 },
                    rental: { '2-20': { base: 450, extraKm: 15, extraHour: 120 }, '4-40': { base: 850, extraKm: 15, extraHour: 120 }, '8-80': { base: 1600, extraKm: 14, extraHour: 100 }, '12-120': { base: 2200, extraKm: 13, extraHour: 100 } }
                },
                sedan: {
                    name: 'Sedan', capacity: '4+1 Seater', maxPassengers: 4,
                    local: { base: 200, perKm: 25, minKm: 0 },
                    oneway: { base: 0, perKm: 13, minKm: 130 },
                    round: { base: 0, perKm: 12, minKmPerDay: 250 },
                    rental: { '2-20': { base: 600, extraKm: 18, extraHour: 150 }, '4-40': { base: 1100, extraKm: 18, extraHour: 150 }, '8-80': { base: 2100, extraKm: 16, extraHour: 120 }, '12-120': { base: 2800, extraKm: 15, extraHour: 120 } }
                },
                suv: {
                    name: 'SUV', capacity: '6+1 Seater', maxPassengers: 6,
                    local: { base: 300, perKm: 35, minKm: 0 },
                    oneway: { base: 0, perKm: 19, minKm: 130 },
                    round: { base: 0, perKm: 18, minKmPerDay: 250 },
                    rental: { '2-20': { base: 900, extraKm: 25, extraHour: 250 }, '4-40': { base: 1600, extraKm: 25, extraHour: 250 }, '8-80': { base: 3100, extraKm: 22, extraHour: 200 }, '12-120': { base: 4200, extraKm: 20, extraHour: 200 } }
                }
            };
        }
    }

    // Initial Fetch
    fetchTariffs();

    // 4. Fare Calculation Logic - ZERO KEY SOLUTION (OSRM)
    async function calculateFare() {
        // Check if user is logged in
        const user = JSON.parse(localStorage.getItem('cityride_member'));
        if (!user) {
            if (fareEstimate) fareEstimate.classList.add('hidden');
            return;
        }

        // Retrieve coordinates stored in datasets by the autocomplete
        const pickupCoords = document.getElementById('pickup').dataset.coords;
        const dropCoords = document.getElementById('drop').dataset.coords;

        if (pickupCoords && dropCoords) {
            try {
                // OSRM via Proxy
                const url = `${API_BASE_URL}/api/proxy/route?pickup=${pickupCoords}&drop=${dropCoords}`;
                const response = await fetch(url);
                const data = await response.json();

                if (data.routes && data.routes.length > 0) {
                    const distanceInKm = Math.ceil(data.routes[0].distance / 1000);
                    


                    renderVehicleOptions(distanceInKm);
                }
            } catch (err) {
                console.error('Distance calculation error:', err);
                renderVehicleOptions(15);
            }
        } else if (currentCategory === 'rental' && pickupCoords) {
            // Rentals don't strictly need a destination for the base package price
            renderVehicleOptions(0);
        } else {
            document.getElementById('vehicle-selection-container').innerHTML = '';
            fareEstimate.classList.add('hidden');
        }
    }

    function renderVehicleOptions(distance) {
        const passengers = parseInt(passengerInput.value) || 1;
        const container = document.getElementById('vehicle-selection-container');
        container.innerHTML = '';

        // Calculate Days for Round Trip
        const start = new Date(pickupDate.value);
        const end = new Date(returnDate.value);
        let tripDays = 1;
        if (end > start) {
            const diffTime = Math.abs(end - start);
            tripDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
        }

        if (!pricing) {
            container.innerHTML = '<div style="padding: 20px; text-align: center; color: #888;">Synchronizing Tariffs...</div>';
            return;
        }

        const allTripTypes = [
            { id: 'local', label: 'Local City Ride', category: 'local' },
            { id: 'oneway', label: 'One-Way Outstation', category: 'outstation' },
            { id: 'round', label: 'Round-Trip Outstation', category: 'outstation' },
            { id: 'rental', label: 'Hourly/KM Rental', category: 'rental' }
        ];

        // Filter types based on active category
        const tripTypes = allTripTypes.filter(t => t.category === currentCategory);

        tripTypes.forEach(tType => {
            // Header for Category
            const header = document.createElement('div');
            header.className = 'list-category-header';
            header.textContent = tType.label;
            container.appendChild(header);

            Object.keys(pricing).forEach(vType => {
                const info = pricing[vType];
                // Check if vehicle is available for this specific trip type
                if (!info[tType.id]) return;

                let totalFare = 0;
                let displayDistance = distance;
                let detailLabel = '';

                const getPeakSurcharge = (timeStr) => {
                    if (!timeStr) return 0;
                    const [h, m] = timeStr.split(':').map(Number);
                    const tm = h * 60 + m;

                    let highestSurcharge = 0;
                    peakRules.forEach(rule => {
                        const [sh, sm] = rule.start_time.split(':').map(Number);
                        const [eh, em] = rule.end_time.split(':').map(Number);
                        const stm = sh * 60 + sm;
                        const etm = eh * 60 + em;

                        if (tm >= stm && tm <= etm) {
                            const surcharge = parseFloat(rule.surcharge_percentage) / 100;
                            if (surcharge > highestSurcharge) highestSurcharge = surcharge;
                        }
                    });
                    return highestSurcharge;
                };

                const peakMult = currentCategory === 'local' ? getPeakSurcharge(document.getElementById('pickup-time').value) : 0;

                if (tType.id === 'local') {
                    const config = info.local;
                    const extraKm = Math.max(0, distance - config.minKm);
                    const baseKmFare = config.base + (extraKm * config.perKm);
                    const peakCharge = baseKmFare * peakMult;
                    
                    const minBill = vType === 'suv' ? 300 : (vType === 'sedan' ? 200 : (vType === 'hatchback' ? 150 : 50));
                    totalFare = Math.max(minBill, baseKmFare + peakCharge) * 1.05;

                    displayDistance = `${distance} KM`;
                    detailLabel = `Incl. 5% GST.`;
                    if (peakMult > 0) detailLabel += ` [Peak Hour +25%]`;
                } else if (tType.id === 'oneway') {
                    const config = info.oneway;
                    const billableDist = Math.max(distance, 130);
                    const driverAllowance = billableDist > 250 ? 600 : 400;
                    const baseFare = (billableDist * config.perKm) + (vType === 'bike' ? 0 : driverAllowance);
                    totalFare = baseFare * 1.05; // Incl 5% GST
                    displayDistance = `${distance} KM`;
                    detailLabel = `Incl. Allowance & 5% GST.`;
                    if (distance < 130) detailLabel += ` [130KM Min Applied]`;
                } else if (tType.id === 'round') {
                    const config = info.round;
                    const minKmForTrip = Math.max(250, config.minKmForTrip || 250);
                    const actualTwoWayDist = distance * 2;
                    const billableDist = Math.max(actualTwoWayDist, minKmForTrip);
                    const driverAllowance = billableDist > 250 ? 600 : 400;
                    const baseFare = (billableDist * config.perKm);
                    totalFare = (baseFare + (vType === 'bike' ? 0 : driverAllowance * tripDays)) * 1.05; // Incl 5% GST
                    displayDistance = `${distance} x 2 (${billableDist} KM Billable)`;
                    detailLabel = `${tripDays} Day(s) • Incl. Allowance & 5% GST.`;
                    if (actualTwoWayDist < 250) detailLabel += ` [250KM Min Applied]`;
                } else if (tType.id === 'rental') {
                    if (!info.rental) return;
                    const packageVal = rentalPackageSelect ? rentalPackageSelect.value : '2-20';
                    const [pMaxHrs, pMaxKm] = packageVal.split('-').map(Number);
                    const config = info.rental[packageVal];
                    if (!config) return;
                    const extraKm = Math.max(0, distance - pMaxKm);
                    const baseFare = config.base + (extraKm * config.extraKm);
                    totalFare = baseFare * 1.05; // Rental usually no bata, but incl 5% GST
                    displayDistance = distance > 0 ? `${distance} KM` : 'Fixed Base';
                    detailLabel = `${pMaxHrs}Hr/${pMaxKm}KM • Extra ₹${config.extraHour}/hr, ₹${config.extraKm}/km • Incl. 5% GST.`;
                }

                totalFare = Math.ceil(totalFare);
                const isDisabled = passengers > info.maxPassengers;

                const card = document.createElement('div');
                card.className = `vehicle-card-item ${isDisabled ? 'vehicle-disabled' : ''}`;
                card.innerHTML = `
                    <div class="vehicle-icon-wrap">
                        ${VEHICLE_ICONS[vType]}
                    </div>
                    <div class="vehicle-info-main">
                        <div class="vehicle-name">${info.name} <span class="vehicle-capacity">${info.capacity}</span></div>
                        <div class="vehicle-capacity" style="font-size: 0.65rem; opacity: 0.8;">${detailLabel}</div>
                        ${isDisabled ? `<div class="vehicle-capacity-warning">Exceeds capacity for ${passengers}</div>` : ''}
                    </div>
                    <div class="vehicle-price-wrap">
                        <div class="vehicle-price">₹${totalFare}</div>
                        <div class="vehicle-eta">Choose</div>
                    </div>
                `;

                if (!isDisabled) {
                    card.onclick = () => {
                        document.querySelectorAll('.vehicle-card-item').forEach(c => c.classList.remove('selected'));
                        card.classList.add('selected');
                        
                        // Update state
                        currentTripType = tType.id;
                        vehicleSelect.value = vType;
                        fareVal.textContent = `₹${totalFare}`;
                        distanceVal.textContent = displayDistance;

                        // Toggle related inputs for better UX
                        if (tType.id === 'round') {
                            returnDateGroup.style.display = 'flex';
                        } else {
                            returnDateGroup.style.display = 'none';
                        }
                    };
                }

                container.appendChild(card);
            });
        });

        const defaultCard = container.querySelector('.vehicle-card-item:not(.vehicle-disabled)');
        if (defaultCard) defaultCard.click();
    }


    // --- ZERO KEY Autocomplete (Photon API by Komoot) ---
    function setupAutocomplete(inputId, suggestionBoxId) {
        const input = document.getElementById(inputId);
        const box = document.getElementById(suggestionBoxId);
        let timeout = null;

        input.addEventListener('input', () => {
            clearTimeout(timeout);
            const query = input.value;

            if (query.length < 3) {
                box.innerHTML = '';
                delete input.dataset.coords;
                return;
            }

            timeout = setTimeout(async () => {
                const url = `${API_BASE_URL}/api/proxy/geocode?q=${encodeURIComponent(query)}&limit=5&lang=en&lon=77.2167&lat=28.6667`; 
                try {
                    const res = await fetch(url);
                    if (!res.ok) throw new Error('API Response Error');
                    const data = await res.json();
                    box.innerHTML = '';

                    if (data.features) {
                        data.features.forEach(feature => {
                            const p = feature.properties;
                            const c = feature.geometry.coordinates; // [lng, lat]

                            // Formulate a professional address string
                            const label = [p.name, p.street, p.city, p.state].filter(Boolean).join(', ');

                            const item = document.createElement('div');
                            item.className = 'suggestion-item';
                            item.textContent = label;

                            item.onclick = () => {
                                input.value = label;
                                input.dataset.coords = `${c[0]},${c[1]}`;
                                box.innerHTML = '';
                                calculateFare(); // Trigger fare update immediately
                            };
                            box.appendChild(item);
                        });
                    }
                } catch (e) {
                    console.error('Autocomplete service unavailable', e);
                }
            }, 400);
        });

        // Hide suggestions on click outside
        document.addEventListener('click', (e) => {
            if (e.target !== input) box.innerHTML = '';
        });
    }

    // --- MAP PICKER LOGIC (Leaflet + OSM) ---
    let map, mapMarker;
    let currentPickingType = 'pickup'; // 'pickup' or 'drop'
    let tempCoords = null;
    let pickupCoords = null;
    let dropCoords = null;

    window.useLiveLocation = function(event, silent = false) {
        if (event && event.currentTarget) {
            const btn = event.currentTarget;
            btn.style.transform = 'scale(0.85)';
            setTimeout(() => btn.style.transform = '', 150);
        }

        if (!navigator.geolocation) return;

        const pickupInput = document.getElementById('pickup');
        if (!silent) {
            pickupInput.placeholder = "Detecting your location...";
            pickupInput.value = "";
        }

        navigator.geolocation.getCurrentPosition(async (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            const coords = `${lng},${lat}`;

            pickupInput.dataset.coords = coords;
            pickupCoords = coords;

            // Reverse Geocode via Proxy
            try {
                const res = await fetch(`${API_BASE_URL}/api/proxy/reverse?lon=${lng}&lat=${lat}`);
                const data = await res.json();
                if (data.features && data.features.length > 0) {
                    const p = data.features[0].properties;
                    const address = [p.name, p.street, p.city, p.district].filter(Boolean).join(', ');
                    pickupInput.value = address;
                }
            } catch (e) {
                console.warn("Silent geocode failed");
            }

            calculateFare();
        }, (err) => {
            alert("Please allow location access to use Live Location.");
        });
    };

    window.openMapPicker = function (type, event) {
        // Add a click animation to the button if event is present
        if (event && event.currentTarget) {
            const btn = event.currentTarget;
            btn.style.transform = 'scale(0.85)';
            setTimeout(() => btn.style.transform = '', 150);
        }

        currentPickingType = type || (pickupCoords ? 'drop' : 'pickup');
        document.getElementById('map-modal').style.display = 'flex';
        document.getElementById('picking-type').textContent = currentPickingType;
        document.getElementById('confirm-location').style.display = 'none';

        // Highlight the associated input box to show target
        document.querySelectorAll('.input-group input').forEach(el => el.classList.remove('input-highlight'));
        const activeInput = document.getElementById(currentPickingType);
        if (activeInput) activeInput.classList.add('input-highlight');

        if (!map) {
            // Initialise map centered on a default location (e.g., Chennai)
            map = L.map('map-picker').setView([13.0827, 80.2707], 13);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; OpenStreetMap contributors'
            }).addTo(map);

            map.on('click', (e) => {
                const { lat, lng } = e.latlng;
                tempCoords = `${lng},${lat}`;

                if (mapMarker) map.removeLayer(mapMarker);
                mapMarker = L.marker([lat, lng]).addTo(map);

                document.getElementById('confirm-location').style.display = 'inline-block';
            });
        } else {
            // Refresh map size if modal was hidden
            setTimeout(() => map.invalidateSize(), 100);
            if (mapMarker) {
                map.removeLayer(mapMarker);
                mapMarker = null;
            }
        }
    };

    window.closeMapPicker = function () {
        document.getElementById('map-modal').style.display = 'none';
        document.querySelectorAll('.input-group input').forEach(el => el.classList.remove('input-highlight'));
    };

    window.confirmMapPoint = async function () {
        if (!tempCoords) return;

        const [lngStr, latStr] = tempCoords.split(',');
        const lng = parseFloat(lngStr);
        const lat = parseFloat(latStr);

        const inputId = currentPickingType;
        const input = document.getElementById(inputId);

        input.dataset.coords = tempCoords;
        if (currentPickingType === 'pickup') pickupCoords = tempCoords;
        else dropCoords = tempCoords;

        // Reverse Geocoding via Proxy
        try {
            const res = await fetch(`${API_BASE_URL}/api/proxy/reverse?lon=${lng}&lat=${lat}`);
            const data = await res.json();
            if (data.features && data.features.length > 0) {
                const p = data.features[0].properties;
                const address = [p.name, p.street, p.city, p.district].filter(Boolean).join(', ');
                input.value = address || `Location at ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
            } else {
                input.value = `Location at ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
            }
        } catch (e) {
            input.value = `Selected Point (${lat.toFixed(2)}, ${lng.toFixed(2)})`;
        }

        closeMapPicker();
        calculateFare();

        // If we just picked pickup, automatically suggest picking drop (Skip for Rental)
        if (currentPickingType === 'pickup' && !dropCoords && currentCategory !== 'rental') {
            setTimeout(() => {
                if (confirm("Now select your destination on the map?")) {
                    openMapPicker('drop');
                }
            }, 500);
        }
    };

    // Initialise Zero-Key Free Services
    setupAutocomplete('pickup', 'pickup-suggestions');
    setupAutocomplete('drop', 'drop-suggestions');

    // Blur listeners for manual entry fallback
    document.getElementById('pickup').addEventListener('blur', () => {
        setTimeout(calculateFare, 250);
    });
    document.getElementById('drop').addEventListener('blur', () => {
        setTimeout(calculateFare, 250);
    });

    // --- Terms & Conditions Modal Logic ---
    let pendingBookingData = null;

    window.openBookingModal = function() {
        const modal = document.getElementById('booking-modal');
        const summary = document.getElementById('booking-summary');
        
        if (pendingBookingData && summary) {
            summary.innerHTML = `
                <div style="padding: 1.2rem; background: #fff8f8; border: 1.5px solid var(--primary-red); border-radius: 16px; font-size: 0.9rem; line-height: 1.6; color: #333;">
                    <div style="font-weight: 800; color: var(--primary-red); margin-bottom: 0.8rem; text-transform: uppercase; letter-spacing: 1px; font-size: 1.1rem;">📋 Important Notice</div>
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        <div><b>@Additional:</b> Toll Fees, Inter-State Permit Airport Charges Parking Charges (if any) are extra.</div>
                        <div><b>@Driver Betta:</b> Rs. 400. [Rs. 600 for above 250kms]</div>
                        <div><b>@Hill Station Charges:</b> - Rs. 400</div>
                        <div><b>@One Way Drop Trips:</b> - Minimum running must be 130 kms</div>
                        <div><b>@Waiting Charges:</b> will be Rs.2 per min. (Except 30 min for food.)</div>
                        <div><b>@Max lagguage capacity by vehicle type:</b><br>-Sedan - 2 suitcases, Suv - 3 suitcases</div>
                    </div>
                </div>
            `;
        }
        
        if (modal) modal.style.display = 'flex';
    };

    window.closeBookingModal = function() {
        const modal = document.getElementById('booking-modal');
        if (modal) modal.style.display = 'none';
        pendingBookingData = null;
    };

    window.confirmBookingWithTerms = async function() {
        if (!pendingBookingData) return;
        
        try {
            const response = await fetch(`${API_BASE_URL}/api/bookings/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pendingBookingData)
            });

            if (response.ok) {
                const result = await response.json();
                alert(`🏨 BOOKING CONFIRMED!\nBooking ID: #B${result.bookingId}\nVerification OTP: ${result.journeyOtp}\n\nYour premium captain will be assigned shortly. Please keep this OTP safe.`);
                bookingForm.reset();
                if (fareEstimate) fareEstimate.classList.add('hidden');
                closeBookingModal();

                // Clear map state
                if (mapMarker) {
                    map.removeLayer(mapMarker);
                    mapMarker = null;
                }

                // Clear coordinate datasets
                document.getElementById('pickup').removeAttribute('data-coords');
                document.getElementById('drop').removeAttribute('data-coords');
                pickupCoords = null;
                dropCoords = null;
                
                // Clear the vehicle options container
                document.getElementById('vehicle-selection-container').innerHTML = '';

                // Redirect to Travelers Hub
                window.location.href = '/dashboard';
            } else {
                const errData = await response.json();
                console.error('Server Booking Error:', errData);
                alert(`Booking failed: ${errData.error || 'Please check your connection.'}`);
            }
        } catch (err) {
            console.error('Submission Error:', err);
            alert('A network error occurred.');
        }
    };

    // 5. Booking Submission - Direct Confirmation
    bookingForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const user = JSON.parse(localStorage.getItem('cityride_member'));
        if (!user) {
            alert('Please login to CityRideTaxi to confirm your booking.');
            window.location.href = '/auth';
            return;
        }

        pendingBookingData = {
            userId: user.id,
            pickup: document.getElementById('pickup').value,
            pickupCoords: document.getElementById('pickup').dataset.coords,
            drop: document.getElementById('drop').value,
            dropCoords: document.getElementById('drop').dataset.coords,
            date: document.getElementById('pickup-date').value,
            time: document.getElementById('pickup-time').value,
            passengers: parseInt(passengerInput.value) || 1,
            vehicle: vehicleSelect.value === 'auto' ? 'sedan' : vehicleSelect.value,
            tripType: currentTripType,
            returnDate: currentTripType === 'round' ? document.getElementById('return-date').value : null,
            rentalPackage: currentTripType === 'rental' ? document.getElementById('rental-package').value : null,
            fare: fareVal.textContent,
            distance: distanceVal.textContent.trim()
        };

        console.log('🚀 Finalizing CityRide Booking Payload:', pendingBookingData);
        
        const fareNum = parseFloat(pendingBookingData.fare.replace(/[^\d.]/g, '')) || 0;
        if (fareNum <= 0) {
            alert('⚠️ Fare Calculation Error: The estimated fare is 0. Please re-enter your locations or adjust your trip parameters to recalculate.');
            return;
        }

        // Redirect to booking modal with summary
        openBookingModal();
    });

    // --- Authentication UI Header Logic ---
    function updateAuthHeader() {
        const member = JSON.parse(localStorage.getItem('cityride_member'));
        const pilot = JSON.parse(localStorage.getItem('cityride_pilot'));
        const master = JSON.parse(localStorage.getItem('cityride_master'));

        const navLinks = document.querySelector('.nav-links');
        const bookBtn = document.querySelector('.nav-cta');
        const logoutBtn = document.getElementById('nav-logout');

        // Hero Button Toggles (Index.html layout without nav)
        const guestActions = document.querySelectorAll('.guest-action');
        const authActions = document.querySelectorAll('.auth-action');
        const heroDashBtn = document.getElementById('hero-dashboard-btn');

        if (member || pilot || master) {
            document.body.classList.add('authenticated');
            guestActions.forEach(btn => btn.style.display = 'none');
            authActions.forEach(btn => btn.style.display = 'block');

            if (heroDashBtn) {
                if (member) {
                    heroDashBtn.textContent = 'My Dashboard';
                    heroDashBtn.onclick = () => window.location.href = '/dashboard';
                } else if (pilot) {
                    heroDashBtn.textContent = 'Driver Portal';
                    heroDashBtn.onclick = () => window.location.href = '/driver';
                } else if (master) {
                    heroDashBtn.textContent = 'Admin Control';
                    heroDashBtn.onclick = () => window.location.href = '/admin';
                }
            }
        } else {
            document.body.classList.remove('authenticated');
            guestActions.forEach(btn => btn.style.display = 'block');
            authActions.forEach(btn => btn.style.display = 'none');
        }

        if (!navLinks) return;

        // Clear existing auth links
        navLinks.querySelectorAll('.auth-link').forEach(l => l.remove());

        if (member || pilot || master) {
            document.body.classList.add('authenticated');

            // Add Member Link
            if (member) {
                const li = document.createElement('li');
                li.className = 'auth-link';
                li.innerHTML = `<a href='/dashboard' style="color:var(--primary-red); font-weight:700;">My Dashboard</a>`;
                navLinks.insertBefore(li, navLinks.firstChild);
            }

            // Add Pilot Link
            if (pilot) {
                const li = document.createElement('li');
                li.className = 'auth-link';
                li.innerHTML = `<a href='/driver' style="color:#FFD700; font-weight:700;">Pilot Portal</a>`;
                navLinks.appendChild(li);
            }

            // Add Admin Link
            if (master) {
                const li = document.createElement('li');
                li.className = 'auth-link';
                li.innerHTML = `<a href='/admin' style="color:#00FF00; font-weight:700;">Control Center</a>`;
                navLinks.appendChild(li);
            }

            // ADDED: Logout button for mobile burger menu
            const logoutLi = document.createElement('li');
            logoutLi.className = 'auth-link menu-button-item mobile-only-item';
            logoutLi.innerHTML = `<button class="btn logout-btn" onclick="logoutUser()" style="display:flex !important;">🚪 Sign Out</button>`;
            navLinks.appendChild(logoutLi);

            // ADDED: Book Now button for mobile burger menu
            const bookLi = document.createElement('li');
            bookLi.className = 'auth-link menu-button-item mobile-only-item';
            bookLi.innerHTML = `<button class="btn btn-primary" onclick="openMapPicker()">Book Now</button>`;
            navLinks.appendChild(bookLi);

            // Update header button text only, don't touch display style
            if (bookBtn) {
                if (member) {
                    bookBtn.textContent = 'Traveler Hub';
                    bookBtn.onclick = () => window.location.href = '/dashboard';
                } else {
                    bookBtn.textContent = 'Book Now';
                    bookBtn.onclick = () => window.location.href = '#booking';
                }
            }

            if (logoutBtn) {
                const primaryName = (member || pilot || master).name.split(' ')[0];
                logoutBtn.textContent = `Logout (${primaryName})`;
            }
        } else {
            document.body.classList.remove('authenticated');

            const li = document.createElement('li');
            li.className = 'auth-link';
            li.innerHTML = `<a href='/auth'>Login</a>`;
            navLinks.appendChild(li);

            // ADDED: Book Now button for mobile burger menu (Guest Mode)
            const bookLi = document.createElement('li');
            bookLi.className = 'auth-link menu-button-item mobile-only-item';
            bookLi.innerHTML = `<button class="btn btn-primary" onclick="openMapPicker()">Book Now</button>`;
            navLinks.appendChild(bookLi);
        }
    }

    window.logoutUser = function () {
        localStorage.removeItem('cityride_member');
        localStorage.removeItem('cityride_pilot');
        localStorage.removeItem('cityride_master');
        window.location.reload();
    }

    updateAuthHeader();

    // Demo: Direct link to panels (for user review)
    // In production, these would be protected by login
    const mainLogo = document.querySelector('.logo');
    if (mainLogo) {
        mainLogo.addEventListener('dblclick', () => {
            if (confirm("Enter Admin Panel?")) window.location.href = '/admin';
        });
    }
});

/**
 * GOOGLE MAPS INTEGRATION NOTES:
 * To enable real distance calculation, add the following script to /:
 * <script src="https://maps.googleapis.com/maps/api/js?key=YOUR_API_KEY&libraries=places"></script>
 * 
 * Then use:
 * let autocompletePickup = new google.maps.places.Autocomplete(document.getElementById('pickup'));
 * let autocompleteDrop = new google.maps.places.Autocomplete(document.getElementById('drop'));
 * 
 * And for fare:
 * let service = new google.maps.DistanceMatrixService();
 * service.getDistanceMatrix({
 *     origins: [pickup],
 *     destinations: [drop],
 *     travelMode: 'DRIVING'
 * }, callback);
 */
