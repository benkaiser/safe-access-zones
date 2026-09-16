#!/usr/bin/env python3
"""
Major Australian population centers with their primary postcodes.
Used for healthdirect search coverage.
"""

SEARCH_LOCATIONS = [
    # NSW - major cities and regional centers
    ("Sydney", "2000", "NSW"),
    ("Parramatta", "2150", "NSW"),
    ("Liverpool", "2170", "NSW"),
    ("Penrith", "2750", "NSW"),
    ("Newcastle", "2300", "NSW"),
    ("Maitland", "2320", "NSW"),
    ("Wollongong", "2500", "NSW"),
    ("Shellharbour", "2529", "NSW"),
    ("Central Coast", "2250", "NSW"),
    ("Gosford", "2250", "NSW"),
    ("Albury", "2640", "NSW"),
    ("Tamworth", "2340", "NSW"),
    ("Orange", "2800", "NSW"),
    ("Dubbo", "2830", "NSW"),
    ("Wagga Wagga", "2650", "NSW"),
    ("Port Macquarie", "2444", "NSW"),
    ("Coffs Harbour", "2450", "NSW"),
    ("Lismore", "2480", "NSW"),
    ("Tweed Heads", "2485", "NSW"),
    ("Grafton", "2460", "NSW"),
    ("Armidale", "2350", "NSW"),
    ("Bathurst", "2795", "NSW"),

    # VIC - major cities and regional centers
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

    # QLD - major cities and regional centers
    ("Brisbane", "4000", "QLD"),
    ("Ipswich", "4305", "QLD"),
    ("Logan", "4114", "QLD"),
    ("Redlands", "4157", "QLD"),
    ("Gold Coast", "4217", "QLD"),
    ("Sunshine Coast", "4558", "QLD"),
    ("Townsville", "4810", "QLD"),
    ("Cairns", "4870", "QLD"),
    ("Toowoomba", "4350", "QLD"),
    ("Mackay", "4740", "QLD"),
    ("Rockhampton", "4700", "QLD"),
    ("Bundaberg", "4670", "QLD"),
    ("Hervey Bay", "4655", "QLD"),
    ("Gladstone", "4680", "QLD"),
    ("Maryborough", "4650", "QLD"),
    ("Maroochydore", "4558", "QLD"),
    ("Noosa", "4567", "QLD"),
    ("Caboolture", "4510", "QLD"),

    # WA - major cities and regional centers
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

    # SA - major cities and regional centers
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

    # TAS - major cities and regional centers
    ("Hobart", "7000", "TAS"),
    ("Launceston", "7250", "TAS"),
    ("Devonport", "7310", "TAS"),
    ("Burnie", "7320", "TAS"),
    ("Ulverstone", "7315", "TAS"),
    ("New Norfolk", "7140", "TAS"),

    # NT - major centers
    ("Darwin", "0800", "NT"),
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


if __name__ == "__main__":
    print(f"Total locations: {len(SEARCH_LOCATIONS)}")
    by_state = {}
    for suburb, postcode, state in SEARCH_LOCATIONS:
        by_state.setdefault(state, []).append((suburb, postcode))
    for state, locs in sorted(by_state.items()):
        print(f"\n{state} ({len(locs)}):")
        for suburb, postcode in locs:
            print(f"  {suburb} {postcode}")