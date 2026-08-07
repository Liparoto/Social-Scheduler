import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono, Noto_Color_Emoji } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});
// Bundled so emoji look the SAME on macOS and Windows, and so an emoji newer than the
// machine's own emoji font still renders instead of showing an empty box — the actual
// complaint from the Windows install. Noto is SIL OFL licensed, so shipping it is allowed;
// Apple Color Emoji is proprietary and is not an option, which is why the picker shows
// Google's designs rather than Apple's.
//
// This changes nothing for the AUDIENCE: a published emoji is a Unicode codepoint drawn by
// the viewer's own device, so an iPhone follower still sees Apple's artwork. This is purely
// about what the author sees while composing.
const notoColorEmoji = Noto_Color_Emoji({
  variable: "--font-noto-emoji",
  subsets: ["emoji"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "SocialScheduler",
  description: "Self-hosted social publishing control room",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="socialscheduler"
      data-mode="light"
      suppressHydrationWarning
      className={`${spaceGrotesk.variable} ${inter.variable} ${jetbrainsMono.variable} ${notoColorEmoji.variable} h-full`}
    >
      {/* Browser extensions (Grammarly and friends) inject attributes and classes onto
          <body> before React hydrates, which React then reports as a hydration mismatch.
          It's the extension, not our markup — suppress it here the same way <html> already
          does. This only covers attributes on this element; a genuine content mismatch
          deeper in the tree is still reported. */}
      <body className="min-h-full" suppressHydrationWarning>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('ss-theme'),m=localStorage.getItem('ss-mode');var v={socialscheduler:1,claude:1,apt:1,fyzical:1,default:1,solarized:1,vela:1};var d=document.documentElement;if(t&&v[t])d.setAttribute('data-theme',t);if(m==='light'||m==='dark')d.setAttribute('data-mode',m);}catch(e){}})();",
          }}
        />
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 min-w-0">{children}</main>
        </div>
      </body>
    </html>
  );
}
