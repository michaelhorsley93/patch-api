/* Seed data for the community picker.
   Bands and lead ranges are ESTIMATES until replaced with real figures.
   After first boot this list lives in the database and is edited at
   /admin/bands.html, so changing it here only affects a fresh database. */

export const SEED_BANDS = [
  // name,      lead_lo, lead_hi, cap   (per slot, per month)
  ["high",      15, 20, 3],
  ["mid",       10, 16, 3],
  ["premium",    5, 10, 2]
];

export const SEED_COMMUNITIES = [
  // Dubai: high volume
  ["Dubai Marina", "Dubai", "high"],
  ["Jumeirah Beach Residence", "Dubai", "high"],
  ["Jumeirah Lake Towers", "Dubai", "high"],
  ["Jumeirah Village Circle", "Dubai", "high"],
  ["Jumeirah Village Triangle", "Dubai", "high"],
  ["Business Bay", "Dubai", "high"],
  ["Downtown Dubai", "Dubai", "high"],
  ["Al Furjan", "Dubai", "high"],
  ["Dubai Sports City", "Dubai", "high"],
  ["Dubai Silicon Oasis", "Dubai", "high"],
  ["Discovery Gardens", "Dubai", "high"],
  ["International City", "Dubai", "high"],
  ["Motor City", "Dubai", "high"],
  ["Arjan", "Dubai", "high"],
  ["Town Square", "Dubai", "high"],
  ["Mirdif", "Dubai", "high"],
  ["Dubai Production City", "Dubai", "high"],
  ["Barsha Heights", "Dubai", "high"],
  ["Al Barsha", "Dubai", "high"],
  ["The Greens and The Views", "Dubai", "high"],
  ["Remraam", "Dubai", "high"],
  ["Dubai South", "Dubai", "high"],
  ["Damac Hills 2", "Dubai", "high"],
  ["Dubailand Residence Complex", "Dubai", "high"],
  ["Al Nahda", "Dubai", "high"],
  ["Al Warqa", "Dubai", "high"],
  ["Deira", "Dubai", "high"],
  ["Bur Dubai", "Dubai", "high"],

  // Dubai: mid volume
  ["Dubai Hills Estate", "Dubai", "mid"],
  ["Arabian Ranches", "Dubai", "mid"],
  ["Arabian Ranches 2", "Dubai", "mid"],
  ["Arabian Ranches 3", "Dubai", "mid"],
  ["The Springs", "Dubai", "mid"],
  ["The Meadows", "Dubai", "mid"],
  ["The Lakes", "Dubai", "mid"],
  ["Jumeirah Park", "Dubai", "mid"],
  ["Jumeirah Islands", "Dubai", "mid"],
  ["Mudon", "Dubai", "mid"],
  ["Damac Hills", "Dubai", "mid"],
  ["Victory Heights", "Dubai", "mid"],
  ["Green Community", "Dubai", "mid"],
  ["Serena", "Dubai", "mid"],
  ["Villanova", "Dubai", "mid"],
  ["The Villa", "Dubai", "mid"],
  ["Meydan", "Dubai", "mid"],
  ["Nad Al Sheba", "Dubai", "mid"],
  ["Tilal Al Ghaf", "Dubai", "mid"],
  ["Dubai Creek Harbour", "Dubai", "mid"],
  ["Dubai Festival City", "Dubai", "mid"],
  ["Dubai Investment Park", "Dubai", "mid"],
  ["City Walk", "Dubai", "mid"],

  // Dubai: premium
  ["Emirates Hills", "Dubai", "premium"],
  ["Palm Jumeirah", "Dubai", "premium"],
  ["Jumeirah Golf Estates", "Dubai", "premium"],
  ["Al Barari", "Dubai", "premium"],
  ["District One", "Dubai", "premium"],
  ["Bluewaters Island", "Dubai", "premium"],
  ["Jumeirah Bay Island", "Dubai", "premium"],
  ["Pearl Jumeirah", "Dubai", "premium"],
  ["La Mer", "Dubai", "premium"],
  ["Umm Suqeim", "Dubai", "premium"],
  ["Jumeirah 1, 2 and 3", "Dubai", "premium"],
  ["Al Wasl", "Dubai", "premium"],
  ["DIFC", "Dubai", "premium"],

  // Abu Dhabi: high volume
  ["Al Reem Island", "Abu Dhabi", "high"],
  ["Khalifa City", "Abu Dhabi", "high"],
  ["Al Reef", "Abu Dhabi", "high"],
  ["Mohammed Bin Zayed City", "Abu Dhabi", "high"],
  ["Shakhbout City", "Abu Dhabi", "high"],
  ["Al Shamkha", "Abu Dhabi", "high"],
  ["Masdar City", "Abu Dhabi", "high"],
  ["Al Ghadeer", "Abu Dhabi", "high"],
  ["Al Raha Gardens", "Abu Dhabi", "high"],
  ["Yas Island", "Abu Dhabi", "high"],

  // Abu Dhabi: mid volume
  ["Al Raha Beach", "Abu Dhabi", "mid"],
  ["Al Bandar", "Abu Dhabi", "mid"],
  ["Al Muneera", "Abu Dhabi", "mid"],
  ["Al Zeina", "Abu Dhabi", "mid"],
  ["Bloom Gardens", "Abu Dhabi", "mid"],
  ["Yas Acres", "Abu Dhabi", "mid"],
  ["Noya", "Abu Dhabi", "mid"],
  ["Alreeman", "Abu Dhabi", "mid"],
  ["Zayed City", "Abu Dhabi", "mid"],
  ["Al Nahyan", "Abu Dhabi", "mid"],
  ["Corniche", "Abu Dhabi", "mid"],

  // Abu Dhabi: carried over from the previous list, not in the prototype
  ["Al Mushrif", "Abu Dhabi", "mid"],
  ["Al Bateen", "Abu Dhabi", "premium"],

  // Abu Dhabi: premium
  ["Saadiyat Island", "Abu Dhabi", "premium"],
  ["Hidd Al Saadiyat", "Abu Dhabi", "premium"],
  ["Jubail Island", "Abu Dhabi", "premium"],
  ["Nurai Island", "Abu Dhabi", "premium"],
  ["Al Maryah Island", "Abu Dhabi", "premium"]
];
