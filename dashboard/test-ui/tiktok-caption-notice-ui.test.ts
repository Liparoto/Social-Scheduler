import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TikTokCaptionNotice,
  needsTikTokCaptionNotice,
} from "../components/tiktok-caption-notice.tsx";

// renderToStaticMarkup gives markup only — no clicks. The copy button's behaviour is
// browser-verified; these tests pin when the notice appears and what it says.

const ig = { id: 1, platform: "instagram", account_name: "liparoto" };
const tiktok = { id: 2, platform: "tiktok", account_name: "liparoto.tt" };

test("the notice is needed only when a tiktok channel is selected", () => {
  assert.equal(needsTikTokCaptionNotice([tiktok]), true);
  assert.equal(needsTikTokCaptionNotice([ig, tiktok]), true);
  assert.equal(needsTikTokCaptionNotice([ig]), false);
  assert.equal(needsTikTokCaptionNotice([]), false);
});

test("the notice says the caption is not sent, and why", () => {
  const html = renderToStaticMarkup(
    React.createElement(TikTokCaptionNotice, { channels: [tiktok], caption: "hello" }),
  );
  assert.match(html, /isn.t sent/i);
  assert.match(html, /TikTok/);
  // The point is to prevent a silent surprise, so it must say where the caption DOES get
  // written rather than only that it is not sent.
  assert.match(html, /write it in the app/i);
});

test("the notice renders nothing when no tiktok channel is selected", () => {
  const html = renderToStaticMarkup(
    React.createElement(TikTokCaptionNotice, { channels: [ig], caption: "hello" }),
  );
  assert.equal(html, "");
});

test("the copy button appears only when there is a caption to copy", () => {
  const withCaption = renderToStaticMarkup(
    React.createElement(TikTokCaptionNotice, { channels: [tiktok], caption: "hello" }),
  );
  assert.match(withCaption, /Copy caption/);

  const blank = renderToStaticMarkup(
    React.createElement(TikTokCaptionNotice, { channels: [tiktok], caption: "   " }),
  );
  // Offering to copy an empty caption is a button that does nothing.
  assert.doesNotMatch(blank, /Copy caption/);
  // ...but the notice itself still shows: the fact is true regardless of the caption.
  assert.match(blank, /isn.t sent/i);
});
