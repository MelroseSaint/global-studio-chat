# QA checklist — Post sharing & user tagging

Manual smoke test for the Facebook-style share + tag feature, run against
the **deployed** app. The production backend and static build are live at:

```
https://outgoing-seal-727.convex.site
```

> ⚠️ `purewire.vercel.app` still runs the previous build until the Vercel
> push is unblocked (needs `vercel login`). Test here, not on vercel.app.

## Prerequisites

- Two accounts: **Account A** (poster) and **Account B** (sharer/tagger).
  Use a second browser profile / incognito window so both can be signed in
  at once (the backend is shared, so notifications cross instantly).
- Use an original photo or short video for the media post. Watch the
  **Photos & videos** tab before starting so you can tell new entries apart.
- Test posts can be deleted afterward (menu → Delete post) — deleting a
  share also fixes the original's share count, so cleanup is safe.

---

## 1. Original post with media + tag (Account A)

1. Sign in as **A**.
2. In the composer, attach a photo, type a caption, and tag **B** using
   the **Tag** button (search B's handle, click it — the `@handle` should
   be inserted at the cursor).
3. Post.

**Verify:**
- [ ] Post appears on the feed with the media and the **Original** badge.
- [ ] A **"with @B"** line shows under the text; the `@B` mention inside
      the text is a clickable link.
- [ ] Clicking `@B` navigates to B's profile.
- [ ] As **B**: a **"mentioned you in a post"** notification appears;
      clicking it opens A's post.

## 2. Share with caption + tag (Account B)

1. Sign in as **B** (second window).
2. On A's post, click the **share** button (arrow icon with the count).
   The dialog opens showing an embedded preview of A's post **including
   its media**.
3. Type a caption and tag **A** via the **Tag** button, then **Share**.

**Verify:**
- [ ] "Shared!" toast appears.
- [ ] The share shows on the feed with **B's** name/avatar, the caption,
      then **"Shared @A's post"** and the embedded card — A's name, their
      original text, **the media**, and like/comment/share counts.
- [ ] Clicking the embedded card (or **View post**) opens A's original.
- [ ] A's original post share count **incremented by 1**.
- [ ] The share appears on **B's profile**.
- [ ] As **A**: a **"shared your post"** notification appears, plus the
      **"mentioned you in a post"** notification for the tag in B's
      caption.

## 3. Photos & videos tab

1. Open **Photos & videos**.

**Verify:**
- [ ] B's share appears (it renders A's media) alongside A's original.
- [ ] **Negative check:** share a *text-only* post (Flow 2, no media) and
      confirm it does **not** appear in Photos & videos — only shares that
      render media belong there.

## 4. Counts & edge cases

**Verify:**
- [ ] **Copy link** (link icon on a post) shows "Link copied" and does
      **not** bump the share count.
- [ ] **Plain repost:** share with an empty caption works and renders just
      the embedded card.
- [ ] **Share-of-a-share flattens:** C shares B's share → the new share
      embeds A's *original*, and A's count increments again (B's count
      does not).
- [ ] **Delete a share:** B deletes their share post → A's original share
      count decrements back.
- [ ] The share dialog closes via the ✕ / overlay / Esc without sharing.
- [ ] Media in the embedded card still renders (image/video/audio all
      replayed correctly from inside a share).
- [ ] Likes/comments on a *share* work normally (the share is a real post).
- [ ] Mentions in a share caption that don't match a real account are
      inert (no tag line, no notification).

## Cleanup

- Delete any test shares/posts (menu → Delete post) and un-follow test
  accounts. Deleting shares keeps the originals' counts correct.
