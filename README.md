# TripleStack — Park Maintenance Tracker

A responsive park-maintenance reporting website built with HTML, CSS, JavaScript and Supabase.

## Features

- Park catalogue with Unsplash reference photographs and photo-page credits.
- Responsive layout for phones, tablets and desktop screens.
- Public complaint reporting with park, category, manual park-area location, description and optional photo evidence.
- Optional GPS capture after the visitor presses the location button and grants browser permission.
- Public maintenance feed with search and park/status filters.
- Public map links use coordinates rounded to 3 decimal places (roughly 100 m), not the exact GPS values stored in the database.
- Supabase Postgres storage for complaints and Supabase Storage for evidence photos.
- Private Storage bucket with short-lived signed viewing URLs for linked report photos.
- Dashboard totals and category/status insights.
- Supabase Auth **Admin Login** with a database allow-list (only approved administrator accounts can manage complaints).
- Staff assignment, request status changes, resolution notes and optional resolution photo.
- Admin-only staff activity history recorded by a database trigger.
- Feedback can be submitted only with the private token issued to the browser that created the report.
- Admin-only Realtime updates; public pages refresh the safe public feed periodically.
- Complaint lists are loaded in 500-row pages, avoiding the default single-response row cap.

See `SECURITY_FIXES.md` for the security changes, deployment checklist and remaining production requirements.

## 1. Create a Supabase project

1. Create a project at https://supabase.com/.
2. Open **Project Settings → API** (or **Connect**) and copy the Project URL and anon/publishable key.
3. In `app.js`, replace `YOUR_SUPABASE_PROJECT_URL` and `YOUR_SUPABASE_ANON_OR_PUBLISHABLE_KEY`.
4. Never put a `service_role` key or any secret key in browser JavaScript.

The Supabase JavaScript CDN dependency is pinned to `2.119.0` rather than an unbounded `@2` URL. Review the [official release history](https://github.com/supabase/supabase-js/releases) before changing it.

## 2. Set up or upgrade the database

1. In Supabase, open **SQL Editor → New query**.
2. Copy all content from `schema.sql` and run it.
3. The script creates or updates the tables, RLS policies, RPC functions, safe public view, audit trigger, indexes, explicit Data API grants and Storage policies.
4. The script is designed as an additive upgrade for the starter project. It keeps existing complaint rows and attempts to migrate old Supabase public-photo URLs into Storage object paths before making the bucket private.
5. Review the SQL before running it against a live production database and take a database backup first.

### Important migration notes

- New public reports are created through `submit_public_complaint`; browser clients no longer have direct INSERT permission on the complaints table.
- Resolution feedback is submitted through `submit_feedback`, which verifies a high-entropy token. General visitor feedback uses a separate `site_feedback` table and the validated `submit_site_feedback` RPC, with a best-effort per-browser limit of three submissions per hour. The raw token is stored only in the reporting browser's local storage; the database stores only its SHA-256 hash.
- Existing reports created before this upgrade do not have feedback tokens. Their existing feedback records remain, but a new feedback submission cannot be claimed by an arbitrary visitor.
- Existing `photo_url` and `resolution_photo_url` values are migrated only when they match the standard Supabase URL pattern `/object/public/issue-photos/<object-path>`. If your project uses a different storage URL format, verify those images before relying on the migration.
- The `issue-photos` bucket is switched to private. The site signs URLs for photos that are linked to a complaint; each signed URL is valid for 10 minutes. Evidence linked to a public complaint is still viewable by public visitors, so do not upload faces, private documents or sensitive images.
- The new `public_complaints` view is the public read interface. It deliberately excludes staff assignment, exact GPS coordinates, reporter identifiers and feedback token hashes. Public map coordinates are rounded to around 100 m.
- Explicit GRANT statements are included because RLS policies alone do not grant Data API table/function privileges on new Supabase projects.

## 3. Create an approved administrator account

1. Open **Authentication → Users → Add user** in Supabase.
2. Create the email/password account.
3. Copy that user's UUID.
4. In SQL Editor, run this statement after replacing the placeholder:

```sql
insert into public.admin_users(user_id)
values ('PASTE-ADMIN-USER-UUID-HERE');
```

Only accounts whose UUID exists in `admin_users` can manage reports. A normal signed-in account is not automatically an administrator. The website button is labelled **Admin Login**; behind the scenes it uses Supabase Auth and verifies administrator access through `is_park_admin()`. It does not read the admin allow-list directly.

**For your college demonstration:** explain that a visitor submits a park complaint without logging in. The administrator opens **Admin Login**, signs in with the pre-created Supabase account, then views reports, assigns a maintenance team, changes status and adds resolution notes/photo. There is intentionally no public “Create Admin Account” button, because visitors must not be able to grant themselves administrator privileges.

## 4. Run the website

- Open the project folder in VS Code.
- Run `index.html` through VS Code Live Server or another local web server.
- Do not open it as a `file://` page.
- For GPS access on a deployed website, use HTTPS. Browsers ask the visitor for permission before providing location.
- Keep browser local storage enabled. The anonymous reporter key is used for best-effort rate limiting, and the feedback token is needed to submit feedback later from the same browser.

## 5. Test the complete flow

1. Submit a report with no photo and no GPS coordinates. Confirm that no map link appears.
2. Submit a report with a JPG, PNG or WEBP image smaller than 5 MB. Confirm that the image appears in the feed using a temporary signed URL.
3. Try an unsupported file type and a file larger than 5 MB. Both should be rejected.
4. Press **Use my current location** and grant permission. Confirm that the public map shows an approximate location, not the exact stored coordinates.
5. Start a GPS request, then type a manual location before the permission callback completes. The manually typed location should remain unchanged and GPS should not be attached.
6. Submit four reports from the same browser within one hour. The fourth should be blocked by the browser-key rate limit.
7. Sign in with the approved administrator account. Assign a report, change its status, add resolution notes/photo and confirm the activity appears in **Recent staff activity**.
8. Confirm a non-admin signed-in account cannot query or update the base complaints table.
9. Submit general feedback using the **Give feedback** button. Sign in as an administrator and confirm it appears in the **Website feedback** inbox below the insights section.
10. Mark a new report resolved. Only the original reporting browser, which holds the feedback token, should see and submit resolution feedback.
11. Open the page in another browser and confirm that the public feed does not reveal staff assignment, feedback tokens or exact GPS coordinates.

## Security model and remaining production work

- **RLS + explicit grants:** Base complaint records are admin-only. Public visitors use a narrow view. Public complaint writes and feedback writes go through validation functions.
- **Photo upload controls:** Visitors first obtain a short-lived, one-time upload intent. The Storage policy accepts only reserved paths or approved staff uploads. Bucket-level file size and MIME type limits are also configured.
- **Best-effort rate limiting:** The database limits reports to 3 per hour and photo upload intents to 5 per hour per random browser key. This reduces casual spam but is not a hard anti-abuse boundary: a determined attacker can clear or rotate browser storage and obtain a new key.
- **Production anti-abuse requirement:** Before a real public/municipal launch, route public submissions through a Supabase Edge Function or equivalent trusted server, verify CAPTCHA (for example, Turnstile) server-side, apply IP-aware rate limits, and add image-content scanning/moderation. The static browser app cannot reliably enforce IP-based throttling or prove that uploaded file bytes match their declared MIME type.
- **Public evidence:** Photos attached to public requests are intentionally viewable by anyone through short-lived links. Do not treat the private bucket as a place to store confidential evidence.
- **Feedback portability:** Feedback ownership is tied to the original browser's local storage. Clearing browser data or changing devices removes the user's feedback key. A production version should use authenticated resident accounts or a secure recovery flow.
- **Data minimization:** Do not collect residents' names, phone numbers, home addresses, or other personal details in public descriptions. The public view still displays the report description and manually entered park-area location.
- **Audit trail:** Staff assignment/status/resolution changes made after this migration are captured in `complaint_activity`. The table is admin-only.
- **Realtime:** Only approved admins subscribe to raw complaint change events. Public pages refresh the filtered public projection every 60 seconds.
- **Secrets:** No Supabase service-role key is included in this project. The anon/publishable key is intended for browser use only when RLS, grants and exposed views are correctly configured.

## Photo sources and credits

Park catalogue images are illustrative, not verified photos of the sample park catalogue entries. They are served from Unsplash image CDN URLs and the interface links to the corresponding photo pages:

- Riverside reference: Amandeep Kaur — https://unsplash.com/photos/a-river-running-through-a-lush-green-park-3K2rIntajKQ
- Greenfield reference: Deepu R — https://unsplash.com/photos/a-lush-green-park-filled-with-lots-of-trees-yX_l4btlLX8
- Playground reference: Demeter Alexandru — https://unsplash.com/photos/a-playground-with-a-slide-and-a-play-structure-QrGqrD5Tdcs

Unsplash licence details: https://unsplash.com/license. The images are used under the Unsplash License; credits are included as a courtesy.

## Files

- `index.html` — page structure, forms and modals
- `style.css` — responsive layout and visual styling
- `app.js` — Supabase connection, GPS capture, reporting, filters, analytics, photo signing and staff workflow
- `schema.sql` — database tables, RLS, RPC functions, public view, audit trail, grants and Storage policies
- `assets/` — reserved for local static assets added later
