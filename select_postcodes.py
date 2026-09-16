#!/usr/bin/env python3
"""
Select representative postcodes across Australia for healthdirect scraping.
Uses geographic clustering to ensure good coverage with minimal overlap.
"""

import csv
import math
from collections import defaultdict
from dataclasses import dataclass
from typing import Any


@dataclass
class Postcode:
    postcode: str
    place_name: str
    state_code: str
    latitude: float
    longitude: float


def load_postcodes() -> list[Postcode]:
    """Load postcodes from CSV, one per unique postcode (using first entry)."""
    postcodes: dict[str, Postcode] = {}
    with open('/Users/benkaiser/Downloads/au_postcodes.csv') as f:
        reader = csv.DictReader(f)
        for row in reader:
            pc = row['postcode']
            if pc not in postcodes:
                postcodes[pc] = Postcode(
                    postcode=pc,
                    place_name=row['place_name'],
                    state_code=row['state_code'],
                    latitude=float(row['latitude']),
                    longitude=float(row['longitude']),
                )
    return list(postcodes.values())


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance in km between two lat/lon points."""
    R = 6371  # Earth radius in km
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def select_representative_postcodes(
    postcodes: list[Postcode],
    max_per_state: dict[str, int],
    min_distance_km: float = 50.0
) -> list[Postcode]:
    """
    Select representative postcodes using greedy farthest-point sampling.
    For each state, pick postcodes that are at least min_distance_km apart.
    """
    # Group by state
    by_state: dict[str, list[Postcode]] = defaultdict(list)
    for pc in postcodes:
        by_state[pc.state_code].append(pc)

    selected = []

    for state_code, state_pcs in by_state.items():
        limit = max_per_state.get(state_code, 5)
        if len(state_pcs) <= limit:
            selected.extend(state_pcs)
            continue

        # Greedy farthest-point sampling
        # Start with the postcode closest to the state centroid
        avg_lat = sum(p.latitude for p in state_pcs) / len(state_pcs)
        avg_lon = sum(p.longitude for p in state_pcs) / len(state_pcs)

        state_pcs.sort(key=lambda p: haversine_km(p.latitude, p.longitude, avg_lat, avg_lon))
        chosen = [state_pcs[0]]

        while len(chosen) < limit:
            best_pc = None
            best_min_dist = -1

            for pc in state_pcs:
                if pc in chosen:
                    continue
                # Find minimum distance to any already-chosen postcode
                min_dist = min(
                    haversine_km(pc.latitude, pc.longitude, c.latitude, c.longitude)
                    for c in chosen
                )
                if min_dist > best_min_dist:
                    best_min_dist = min_dist
                    best_pc = pc

            if best_pc and best_min_dist >= min_distance_km:
                chosen.append(best_pc)
            else:
                # No more postcodes far enough apart, pick the best anyway
                if best_pc:
                    chosen.append(best_pc)
                break

        selected.extend(chosen)
        print(f"  {state_code}: selected {len(chosen)} postcodes (from {len(state_pcs)})")

    return selected


def main():
    postcodes = load_postcodes()
    print(f"Total unique postcodes: {len(postcodes)}")

    # Max postcodes per state (tuned for coverage vs API calls)
    max_per_state = {
        'NSW': 15,
        'VIC': 12,
        'QLD': 12,
        'WA': 10,
        'SA': 8,
        'TAS': 6,
        'NT': 4,
        'ACT': 3,
    }

    print("\nSelecting representative postcodes...")
    selected = select_representative_postcodes(postcodes, max_per_state, min_distance_km=80)

    print(f"\nTotal selected: {len(selected)}")

    # Print details for verification
    for pc in sorted(selected, key=lambda p: (p.state_code, p.postcode)):
        print(f"  {pc.postcode} {pc.place_name:30s} {pc.state_code}  ({pc.latitude:.4f}, {pc.longitude:.4f})")

    # Save to JSON for the scraper
    import json
    output = [
        {"suburb": pc.place_name, "postcode": pc.postcode, "state": pc.state_code,
         "latitude": pc.latitude, "longitude": pc.longitude}
        for pc in selected
    ]
    with open('search_locations.json', 'w') as f:
        json.dump(output, f, indent=2)
    print("\nSaved to search_locations.json")


if __name__ == '__main__':
    main()