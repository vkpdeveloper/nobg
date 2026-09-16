import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SITE_TITLE } from "@/lib/site";

export const alt = SITE_TITLE;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const SQ = 40;
const COLS = 12;
const ROWS = 16;

export default async function Image() {
  const [semiBold, regular] = await Promise.all([
    readFile(join(process.cwd(), "src/app/_fonts/Geist-SemiBold.ttf")),
    readFile(join(process.cwd(), "src/app/_fonts/Geist-Regular.ttf")),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          backgroundColor: "#0a0a0a",
          fontFamily: "Geist",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            paddingLeft: 80,
            width: 720,
            height: "100%",
          }}
        >
          <svg width="96" height="96" viewBox="0 0 32 32">
            <rect width="32" height="32" rx="8" fill="#1f1f1f" />
            <path
              d="M11 22V10l10 12V10"
              fill="none"
              stroke="#fafafa"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div
            style={{
              marginTop: 40,
              fontSize: 120,
              fontWeight: 600,
              letterSpacing: "-0.04em",
              color: "#fafafa",
              lineHeight: 1,
            }}
          >
            NOBG
          </div>
          <div
            style={{
              marginTop: 24,
              fontSize: 44,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: "#fafafa",
            }}
          >
            Remove backgrounds. Instantly.
          </div>
          <div
            style={{
              marginTop: 20,
              fontSize: 30,
              fontWeight: 400,
              color: "#8a8a8a",
            }}
          >
            Free · Private · On-device
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            width: 480,
            height: "100%",
            overflow: "hidden",
          }}
        >
          {Array.from({ length: COLS * ROWS }).map((_, i) => (
            <div
              key={i}
              style={{
                width: SQ,
                height: SQ,
                backgroundColor:
                  (Math.floor(i / COLS) + (i % COLS)) % 2 === 0
                    ? "#141414"
                    : "#1b1b1b",
              }}
            />
          ))}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: semiBold, weight: 600, style: "normal" },
        { name: "Geist", data: regular, weight: 400, style: "normal" },
      ],
    },
  );
}
