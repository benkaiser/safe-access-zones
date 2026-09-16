#!/usr/bin/env python3
"""
Scrape pregnancy termination services from healthdirect.gov.au across Australia.

Uses verified working URL slugs for population centers to ensure successful scraping.
"""

import csv
import json
import math
import re
import random
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


BASE_URL = "https://www.healthdirect.gov.au/australian-health-services/search"
SERVICE_ID = "310062002"
SERVICE_SLUG = "pregnancy-termination"

POSTCODES_CSV = Path("/Users/benkaiser/Downloads/au_postcodes.csv")
OUTPUT_FILE = Path("pregnancy_termination_services.json")
COVERAGE_FILE = Path("coverage_postcodes.json")
SOURCE_METADATA_FILE = Path("data/source-metadata.json")

# Rate limiting
MIN_DELAY = 1.5
MAX_DELAY = 4.0

# Verified working search locations (suburb, postcode, state)
# These are population centers with known working URL slugs
VERIFIED_LOCATIONS = [
    # NSW
    ("Sydney", "2000", "NSW"),
    ("Parramatta", "2150", "NSW"),
    ("Liverpool", "2170", "NSW"),
    ("Penrith", "2750", "NSW"),
    ("Newcastle", "2300", "NSW"),
    ("Maitland", "2320", "NSW"),
    ("Wollongong", "2500", "NSW"),
    ("Gosford", "2250", "NSW"),
    ("Albury", "2640", "NSW"),
    ("Tamworth", "2340", "NSW"),
    ("Orange", "2800", "NSW"),
    ("Dubbo", "2830", "NSW"),
    ("Wagga Wagga", "2650", "NSW"),
    ("Port Macquarie", "2444", "NSW"),
    ("Coffs Harbour", "2450", "NSW"),
    ("Grafton", "2460", "NSW"),
    ("Lismore", "2480", "NSW"),
    ("Tweed Heads", "2485", "NSW"),
    ("Armidale", "2350", "NSW"),
    ("Bathurst", "2795", "NSW"),
    ("Broken Hill", "2880", "NSW"),
    # VIC
    ("Melbourne", "3000", "VIC"),
    ("Geelong", "3220", "VIC"),
    ("Ballarat", "3350", "VIC"),
    ("Bendigo", "3550", "VIC"),
    ("Shepparton", "3630", "VIC"),
    ("Mildura", "3500", "VIC"),
    ("Warrnambool", "3280", "VIC"),
    ("Wodonga", "3690", "VIC"),
    ("Traralgon", "3844", "VIC"),
    ("Morwell", "3840", "VIC"),
    ("Sale", "3850", "VIC"),
    ("Bairnsdale", "3875", "VIC"),
    ("Horsham", "3400", "VIC"),
    ("Wangaratta", "3677", "VIC"),
    ("Benalla", "3672", "VIC"),
    # QLD
    ("Brisbane City", "4000", "QLD"),
    ("Ipswich", "4305", "QLD"),
    ("Logan Central", "4114", "QLD"),
    ("Capalaba", "4157", "QLD"),
    ("Surfers Paradise", "4217", "QLD"),
    ("Maroochydore", "4558", "QLD"),
    ("Noosa Heads", "4567", "QLD"),
    ("Townsville", "4810", "QLD"),
    ("Cairns", "4870", "QLD"),
    ("Toowoomba", "4350", "QLD"),
    ("Mackay", "4740", "QLD"),
    ("Rockhampton", "4700", "QLD"),
    ("Bundaberg", "4670", "QLD"),
    ("Hervey Bay", "4655", "QLD"),
    ("Gladstone", "4680", "QLD"),
    ("Maryborough", "4650", "QLD"),
    ("Caboolture", "4510", "QLD"),
    # WA
    ("Perth", "6000", "WA"),
    ("Fremantle", "6160", "WA"),
    ("Mandurah", "6210", "WA"),
    ("Bunbury", "6230", "WA"),
    ("Busselton", "6280", "WA"),
    ("Geraldton", "6530", "WA"),
    ("Kalgoorlie", "6430", "WA"),
    ("Albany", "6330", "WA"),
    ("Broome", "6725", "WA"),
    ("Port Hedland", "6721", "WA"),
    ("Karratha", "6714", "WA"),
    ("Esperance", "6450", "WA"),
    ("Northam", "6401", "WA"),
    ("Collie", "6225", "WA"),
    # SA
    ("Adelaide", "5000", "SA"),
    ("Mount Gambier", "5290", "SA"),
    ("Whyalla", "5600", "SA"),
    ("Port Augusta", "5700", "SA"),
    ("Port Lincoln", "5606", "SA"),
    ("Murray Bridge", "5253", "SA"),
    ("Victor Harbor", "5211", "SA"),
    ("Port Pirie", "5540", "SA"),
    ("Kadina", "5554", "SA"),
    ("Roxby Downs", "5725", "SA"),
    # TAS
    ("Hobart", "7000", "TAS"),
    ("Launceston", "7250", "TAS"),
    ("Devonport", "7310", "TAS"),
    ("Burnie", "7320", "TAS"),
    ("Ulverstone", "7315", "TAS"),
    ("New Norfolk", "7140", "TAS"),
    # NT
    ("Darwin City", "0800", "NT"),
    ("Palmerston", "0830", "NT"),
    ("Alice Springs", "0870", "NT"),
    ("Katherine", "0850", "NT"),
    ("Nhulunbuy", "0880", "NT"),
    ("Tennant Creek", "0860", "NT"),
    # ACT
    ("Canberra", "2600", "ACT"),
    ("Belconnen", "2617", "ACT"),
    ("Tuggeranong", "2900", "ACT"),
    ("Gungahlin", "2912", "ACT"),
    ("Woden", "2606", "ACT"),
]


@dataclass
class SearchLocation:
    suburb: str
    postcode: str
    state: str
    latitude: float = 0.0
    longitude: float = 0.0


def create_session() -> requests.Session:
    """Create a requests session with retry strategy and browser-like headers."""
    session = requests.Session()
    retry_strategy = Retry(
        total=3,
        backoff_factor=2,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["HEAD", "GET", "OPTIONS"],
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
    })
    return session


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance in km between two lat/lon points."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def load_postcode_centroids() -> dict[str, dict[str, Any]]:
    """Load postcode centroids from CSV for coverage analysis."""
    centroids = {}
    with open(POSTCODES_CSV) as f:
        reader = csv.DictReader(f)
        for row in reader:
            pc = row['postcode']
            if pc not in centroids:
                centroids[pc] = {
                    'postcode': pc,
                    'state': row['state_code'],
                    'latitude': float(row['latitude']),
                    'longitude': float(row['longitude']),
                }
    return centroids


def check_coverage(locations: list[SearchLocation], postcode_centroids: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Check how many postcodes are within 300km of search locations."""
    SEARCH_RADIUS_KM = 300

    covered = set()
    uncovered = []

    for pc, data in postcode_centroids.items():
        lat = data['latitude']
        lon = data['longitude']
        for loc in locations:
            if haversine_km(lat, lon, loc.latitude, loc.longitude) <= SEARCH_RADIUS_KM:
                covered.add(pc)
                break
        else:
            uncovered.append(pc)

    return {
        'total_postcodes': len(postcode_centroids),
        'covered': len(covered),
        'uncovered': len(uncovered),
        'coverage_pct': round(100 * len(covered) / len(postcode_centroids), 2) if postcode_centroids else 0,
        'uncovered_postcodes': uncovered[:50],
    }


def extract_next_data(html: str) -> dict[str, Any] | None:
    """Extract the __NEXT_DATA__ JSON from the HTML."""
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return None


def extract_services(page_props: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract all services from page props (physical, phone, home visits)."""
    all_services = []

    hs = page_props.get("healthcareServices", {})
    if isinstance(hs, dict):
        all_services.extend(hs.get("services", []))

    ps = page_props.get("_phoneServices")
    if isinstance(ps, dict):
        all_services.extend(ps.get("services", []))
    elif isinstance(ps, list):
        all_services.extend(ps)

    hv = page_props.get("_homeVisits")
    if isinstance(hv, dict):
        all_services.extend(hv.get("services", []))
    elif isinstance(hv, list):
        all_services.extend(hv)

    return all_services


def normalize_service(service: dict[str, Any]) -> dict[str, Any]:
    """Normalize service data for consistent deduplication."""
    result = {
        'id': service.get('id', ''),
        'name': service.get('organisation', {}).get('name', ''),
        'service_type': service.get('serviceType', [{}])[0].get('label', ''),
        'suburb': '',
        'state': '',
        'postcode': '',
        'latitude': None,
        'longitude': None,
        'phone': '',
        'email': '',
        'website': '',
        'hours': {},
        'is_virtual': False,
        'appointment_required': False,
        'billing_options': [],
        'facilities': [],
        'description': service.get('description', ''),
        'search_location': '',
    }

    loc = service.get('location', {}).get('physicalLocation', {})
    if loc:
        result['suburb'] = loc.get('suburb', {}).get('label', '')
        result['state'] = loc.get('state', {}).get('label', '')
        result['postcode'] = loc.get('postcode', '')
        geo = loc.get('geocode', {})
        result['latitude'] = geo.get('latitude')
        result['longitude'] = geo.get('longitude')
    else:
        result['is_virtual'] = True

    delivery = service.get('location', {}).get('deliveryMethod', '')
    if delivery == 'VIRTUAL':
        result['is_virtual'] = True

    for contact in service.get('contacts', []):
        value_type = contact.get('valueType', {}).get('label', '')
        value = contact.get('value', '')
        if value_type == 'Phone':
            result['phone'] = value
        elif value_type == 'Email':
            result['email'] = value
        elif value_type == 'Website':
            result['website'] = value

    calendar = service.get('calendar', {})
    if calendar:
        result['hours']['timezone'] = calendar.get('timezone', '')
        result['hours']['weekly_calendar'] = calendar.get('weeklyCalendar', {})

    appt = service.get('appointment', {})
    result['appointment_required'] = bool(appt.get('appointmentSlots') or appt.get('earliestAppointmentsInDays', 0) == 0)

    for bill in service.get('billingOptions', []):
        result['billing_options'].append(bill.get('value', ''))

    for fac in service.get('facilities', []):
        result['facilities'].append(fac.get('valueType', {}).get('label', ''))

    result['search_location'] = service.get('searchLocation', '')

    return result


def scrape_location(session: requests.Session, suburb: str, postcode: str, state: str) -> tuple[int, list[dict[str, Any]]]:
    """Scrape services for a single location. Returns (status_code, services)."""
    slug = f"{suburb.lower().replace(' ', '-')}-{postcode}-{state.lower()}"
    url = f"{BASE_URL}/{slug}/{SERVICE_SLUG}/{SERVICE_ID}"

    print(f"  Scraping {suburb} {postcode} {state}...")

    try:
        response = session.get(url, timeout=15)
        if response.status_code != 200:
            print(f"    Status {response.status_code}, skipping")
            return (response.status_code, [])
        response.raise_for_status()
    except requests.RequestException as e:
        print(f"    Error: {e}")
        return (0, [])

    next_data = extract_next_data(response.text)
    if not next_data:
        print(f"    No data found")
        return (200, [])

    page_props = next_data.get('props', {}).get('pageProps', {})
    services = extract_services(page_props)
    normalized = [normalize_service(s) for s in services]

    print(f"    Found {len(normalized)} services")
    return (200, normalized)


def deduplicate_services(services: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate services by ID, then by name+location."""
    seen_ids: set[str] = set()
    seen_combos: set[str] = set()
    unique = []

    for service in services:
        svc_id = service.get('id', '')
        name = service.get('name', '')
        state = service.get('state', '')
        postcode = service.get('postcode', '')

        if svc_id and svc_id in seen_ids:
            continue
        if svc_id:
            seen_ids.add(svc_id)

        combo = f"{name}|{state}|{postcode}"
        if combo in seen_combos:
            continue
        seen_combos.add(combo)

        unique.append(service)

    return unique


def main():
    print("=" * 60)
    print("Healthdirect Pregnancy Termination Scraper")
    print("=" * 60)

    # Load postcode centroids for coverage analysis
    postcode_centroids = load_postcode_centroids()

    # Build search location objects with coordinates from CSV
    search_locations: list[SearchLocation] = []
    if postcode_centroids:
        for suburb, postcode, state in VERIFIED_LOCATIONS:
            key = f"{postcode}_{state}"
            coords = None
            for pc, data in postcode_centroids.items():
                if data['postcode'] == postcode and data['state'] == state:
                    coords = data
                    break
            if coords:
                search_locations.append(SearchLocation(
                    suburb=suburb, postcode=postcode, state=state,
                    latitude=coords['latitude'], longitude=coords['longitude']
                ))
            else:
                search_locations.append(SearchLocation(suburb, postcode, state))
    else:
        for suburb, postcode, state in VERIFIED_LOCATIONS:
            search_locations.append(SearchLocation(suburb, postcode, state))

    print(f"\nSearch locations: {len(search_locations)}")

    # Coverage analysis
    if postcode_centroids:
        coverage = check_coverage(search_locations, postcode_centroids)
        print(f"\nCoverage analysis (300km radius):")
        print(f"  Total postcodes: {coverage['total_postcodes']}")
        print(f"  Covered: {coverage['covered']} ({coverage['coverage_pct']}%)")
        if coverage['uncovered_postcodes']:
            print(f"  Uncovered: {coverage['uncovered']}")
            print(f"  Sample uncovered: {coverage['uncovered_postcodes'][:10]}")

    # Load existing data
    all_services = []
    if OUTPUT_FILE.exists():
        try:
            with open(OUTPUT_FILE) as f:
                all_services = json.load(f)
            print(f"\nLoaded {len(all_services)} existing services")
        except (json.JSONDecodeError, OSError):
            pass

    seen_services: set[str] = {s.get('id', '') for s in all_services if s.get('id')}

    session = create_session()

    print(f"\nStarting scrape of {len(search_locations)} locations...")
    new_count = 0
    failed = []

    for i, loc in enumerate(search_locations):
        print(f"\n[{i+1}/{len(search_locations)}] {loc.suburb}, {loc.state} {loc.postcode}")

        status, services = scrape_location(session, loc.suburb, loc.postcode, loc.state)

        if status != 200:
            failed.append((loc.suburb, loc.postcode, loc.state, status))

        new_services = [s for s in services if s.get('id') not in seen_services]
        if new_services:
            all_services.extend(new_services)
            for s in new_services:
                if s.get('id'):
                    seen_services.add(s['id'])
            new_count += len(new_services)
            print(f"    Added {len(new_services)} new services")

        with open(OUTPUT_FILE, 'w') as f:
            json.dump(all_services, f, indent=2, ensure_ascii=False)

        if i < len(search_locations) - 1:
            delay = random.uniform(MIN_DELAY, MAX_DELAY)
            time.sleep(delay)

    all_services = deduplicate_services(all_services)

    with open(OUTPUT_FILE, 'w') as f:
        json.dump(all_services, f, indent=2, ensure_ascii=False)

    print(f"\n\n{'='*60}")
    print(f"Done! Total unique services: {len(all_services)}")
    print(f"New services added: {new_count}")
    print(f"Failed locations: {len(failed)}")
    if failed:
        print(f"Failed locations: {failed}")
    print(f"{'='*60}")

    # Summary by state
    by_state: dict[str, int] = {}
    virtual_count = 0
    for s in all_services:
        if s.get('is_virtual'):
            virtual_count += 1
        else:
            state = s.get('state', 'UNKNOWN')
            by_state[state] = by_state.get(state, 0) + 1

    print(f"\nPhysical services by state:")
    for state, count in sorted(by_state.items()):
        print(f"  {state}: {count}")
    print(f"Virtual/Phone services: {virtual_count}")

    # Save coverage info
    if postcode_centroids:
        coverage = check_coverage(search_locations, postcode_centroids)
        with open(COVERAGE_FILE, 'w') as f:
            json.dump(coverage, f, indent=2)
        print(f"\nCoverage report saved to {COVERAGE_FILE}")

    source_metadata = {
        "publisher": "Healthdirect Australia",
        "dataset": "National Health Services Directory (NHSD)",
        "source_url": "https://www.healthdirect.gov.au/australian-health-services",
        "service_category": "Pregnancy termination",
        "service_category_id": SERVICE_ID,
        "synced_at": datetime.now(timezone.utc).isoformat(
            timespec="seconds"
        ).replace("+00:00", "Z"),
        "source_records": len(all_services),
        "completed_with_errors": bool(failed),
        "failed_search_locations": [
            {
                "suburb": suburb,
                "postcode": postcode,
                "state": state,
                "status": status,
            }
            for suburb, postcode, state, status in failed
        ],
    }
    SOURCE_METADATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(SOURCE_METADATA_FILE, 'w') as f:
        json.dump(source_metadata, f, indent=2)
        f.write("\n")
    print(f"Source sync metadata saved to {SOURCE_METADATA_FILE}")


if __name__ == "__main__":
    main()