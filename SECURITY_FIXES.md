# Security and reliability update

This update hardens the supplied TripleStack Park Maintenance starter project while keeping its existing public report, park catalogue, GPS, photo evidence, Admin Login, analytics and feedback workflows.

## Changes implemented

- Replaced public access to the full complaints table with a narrow `public_complaints` view. Public responses omit staff assignment, exact stored GPS coordinates, feedback-token hashes and internal activity records.
- Added explicit table/view grants alongside row-level security policies. Direct public INSERT access to the complaints table and direct public feedback writes are removed.
- Routed public report creation and feedback submission through validated database functions. Feedback requires a high-entropy, one-time token whose hash is stored in the database.
- Made the evidence bucket private. Uploads require a short-lived, one-time reserved path, are limited to JPG/PNG/WEBP and 5 MB, and are shown through 10-minute signed URLs only after the object is linked to a report (or to approved staff evidence).
- Made upload paths opaque and non-correlating; public file paths no longer contain a stable reporter-key hash.
- Added best-effort limits of three reports per hour and five photo-upload intents per hour per browser key, with expiry cleanup and indexes.
- Rounded public map coordinates to three decimal places and fixed the missing-GPS map link so null coordinates never become `0,0`.
- Added admin-only staff-change history, including status, assignment and resolution updates.
- Added 500-row paged reads, admin-only row refreshes for Realtime events, and periodic safe-view refreshes for public visitors.
- Improved modal focus handling, keyboard navigation for the rating control, GPS/manual-location race handling and network-error feedback.
- Pinned the Supabase JavaScript CDN dependency to a specific version.

## Deployment steps

1. Back up your existing Supabase database.
2. Run the updated `schema.sql` in the Supabase SQL Editor using the project owner context.
3. Set the Supabase project URL and anon/publishable key in `app.js`.
4. Create the approved administrator account and add its Auth user UUID to `public.admin_users`, following `README.md`.
5. Test the report, photo, feedback and staff workflows against the actual Supabase project before public use.

## Remaining production requirements

The anonymous rate limit is intentionally described as **best effort**: it uses a random browser key, which a determined attacker can clear or rotate. A real public/municipal deployment should put report and upload-intent creation behind a trusted Supabase Edge Function (or equivalent), verify CAPTCHA server-side, rate-limit by request IP and add image-content scanning/moderation. The static browser app cannot securely perform those server-side controls itself.

Public report evidence is designed to be viewable by anyone through short-lived links. Do not upload confidential or personally identifying images. Feedback keys are kept in the originating browser's local storage; clearing that storage or changing devices prevents feedback from that browser.

## Verification performed

- JavaScript syntax check (`node --check app.js`).
- Static HTML ID/reference checks (no duplicate element IDs or missing literal JavaScript element references).
- CSS parser check.
- Targeted JavaScript helper checks for null GPS coordinates, URL filtering and text escaping.
- ZIP integrity check after packaging.

Live Supabase queries, Storage policies, Auth, Realtime and SQL migration execution still need to be verified against your own Supabase project. The source ZIP contains placeholder credentials and cannot exercise your hosted project by itself.

- **General visitor feedback:** Added a separate public feedback form and RPC. Input is validated, browser-key submissions are throttled to three per hour, and feedback rows are readable only by approved administrators. This is best-effort browser-level throttling, not a substitute for IP-aware rate limiting/CAPTCHA.
