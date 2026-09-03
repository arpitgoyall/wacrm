import { ImageResponse } from "next/og";

// Replaces the default Next.js favicon with the Aerocadmy WhatsApp mark.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#25D366",
          borderRadius: 6,
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.7-1.2A9 9 0 1 0 12 3Z" />
          <path d="M8.5 8.5c.3-.7.6-.7 1-.7h.3c.2 0 .4.1.5.4l.8 1.8c.1.3.1.5-.1.7l-.5.6c-.2.2-.2.4 0 .7.3.5 1.1 1.5 2 2 .7.4 1.2.6 1.5.7.3.1.5.1.7-.2l.6-.8c.2-.2.4-.2.7-.1l1.8.8c.3.1.4.3.4.5 0 .4-.2 1.2-.6 1.5-.4.3-1 .5-1.6.5-.4 0-.9-.1-1.4-.3-2.6-.9-4.5-3.7-4.7-4-.2-.3-1.1-1.5-1.1-2.8 0-1.2.6-1.8.7-2.1Z" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
