# GameJournal 🎮
**A social platform for video game tracking, reviews, and discovery.**

[Link to Live Demo](https://gamejournal.vercel.app/)

## 🚀 The Vision
GameJournal bridges the gap between tracking your gaming backlog and discovering new experiences through a social lens. Designed for gamers who want a "Letterboxd-like" experience to journal their progress and connect with others.

## 🛠️ Tech Stack
* **Frontend:** Next.js (App Router), Tailwind CSS, Framer Motion
* **Backend:** Supabase (PostgreSQL, Auth, Realtime)
* **API/Infrastructure:** Vercel Edge Runtime, Server Actions
* **Media:** Custom OG image generation (`@resvg/resvg-js`)

## 🔑 Key Features
* **Social Graph:** Real-time activity feed with Global, Following, and Trending views.
* **Diary & Logging:** Track gameplay with custom tags, review ratings, and diary dates.
* **Dynamic Social Sharing:** Server-side generated OpenGraph cards for every log, optimized for Twitter/Discord sharing.
* **Database Security:** Robust RLS policies ensuring data integrity while maintaining performant public read access.

## 🧠 Technical Challenges Solved
1. **Performance at Scale:** Implemented server-side data fetching via Server Actions to bypass client-side RLS bottlenecks.
2. **Dynamic Social Preview:** Built an Edge-runtime API that generates 1200x630 OG images on the fly, rendering game metadata dynamically.
3. **Optimistic UI:** Implemented local state updates for "Like" actions to ensure a sub-100ms response feel for users.

## ⚙️ Getting Started
1. Clone the repo: `git clone https://github.com/NITHISH-2006/gamejournal.git`
2. Install dependencies: `npm install`
3. Set up environment variables (.env.local): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Run locally: `npm run dev`

---
*Built by Nithish C.*
