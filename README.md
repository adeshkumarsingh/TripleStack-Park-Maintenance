TripleStack – Park Maintenance Tracker
A web-based application designed to help people report park maintenance issues and allow administrators to manage and track complaints.
Features

Park catalogue with reference photographs.
Responsive interface for mobile, tablet and desktop.
Public complaint submission.
Complaint categories and park-area location.
Optional GPS location capture with user permission.
Optional photo evidence upload.
Public complaint feed with search and filters.
Approximate public map locations.
Administrator login.
Complaint management and staff assignment.
Complaint status updates and resolution notes.
Website feedback submission.
Dashboard with complaint statistics.

Technologies Used

HTML
CSS
JavaScript
Supabase
PostgreSQL
Supabase Authentication
Supabase Storage

Project Structure

index.html — Main website structure.
style.css — Layout and responsive styling.
app.js — Application functionality and Supabase integration.
schema.sql — Database schema and policies.
assets/ — Static assets.

Setup Instructions

Clone or download this repository.
Create a project in Supabase.
Configure the Supabase Project URL and anon/publishable key in app.js.
Run the SQL script from schema.sql in the Supabase SQL Editor.
Configure an approved administrator account.
Run the project using VS Code Live Server or deploy it using GitHub Pages.

Security Notes

Never expose Supabase service-role keys in frontend code.
Configure Row Level Security (RLS) before public deployment.
Keep administrator access restricted to approved accounts.

Photo Credits
Reference photographs are sourced from Unsplash under the Unsplash License.
Deployment
The project can be hosted using GitHub Pages with Supabase as its backend.
