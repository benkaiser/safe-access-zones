Different states in Australia have different laws pertaining to anti-abortion protesting, but they all universally now have a safe access exclusion zone of 150 meters from a facility where abortions are performed, excluding pharmacies. This means that aside from dedicated abortion clinics, general doctors could qualify if they prescribe abortion medication.

This tool (website) provides a map that shows the exclusion zones around every abortion clinic and doctors office in Australia.

At a high level, it should:
- allow you to toggle on/off doctors as a group, and abortion clinics as a group (and color code each of those)
- "group" pins together when zoomed out too far, but show the proper exclusion area when zoomed in.
- try to attain the building boundary from an API like OSM to draw the exclusion zone properly, but if it can't be attained, just draw the 150m circle + a 50m on top of that as a "hazy" potential exclusion zone because we don't know the propery permiter dimensions.

The map should render using a completely free to use mapping software, and although we can build the data from scripts or dynamically, the final result will be a static site so that it loads extremely fast and can be hosted on GitHub Pages.

There should also be part of the tool that is used locally to help "clean up" the boundary marks for properties we don't know the boundaries of (by letting the user draw the boundary manually if possible). It should also allow for adding/removing locations in a CRM-style, but require a note for each of them for why they weren't in the original dataset, or why they are being removed (known clinic that refuses to prescribe abortion pills).
