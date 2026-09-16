import { GITHUB_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

export const FAQS = [
  {
    q: "Is nobg really free?",
    a: "Yes. nobg is free and open source with no accounts, limits or watermarks.",
  },
  {
    q: "Are my images uploaded anywhere?",
    a: "No. Background removal runs entirely on your device inside the browser. Your images never leave your computer.",
  },
  {
    q: "Which formats are supported?",
    a: "PNG, JPG and WEBP input. Results are downloaded as transparent PNG files.",
  },
  {
    q: "Can I remove backgrounds from multiple images at once?",
    a: "Yes. Drop as many images as you like and nobg processes them in a batch, adapting to your device's performance.",
  },
] as const;

const graph = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebApplication",
      name: SITE_NAME,
      url: SITE_URL,
      description: SITE_DESCRIPTION,
      applicationCategory: "MultimediaApplication",
      operatingSystem: "Any (browser)",
      browserRequirements: "Modern browser with WebGPU or WebAssembly",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      isAccessibleForFree: true,
      featureList: [
        "Remove image backgrounds",
        "Batch processing",
        "Transparent PNG output",
        "On-device processing — no uploads",
        "Copy to clipboard",
      ],
      sameAs: [GITHUB_URL],
      author: { "@type": "Person", name: "vkpdeveloper", url: GITHUB_URL },
    },
    {
      "@type": "WebSite",
      name: SITE_NAME,
      url: SITE_URL,
    },
    {
      "@type": "FAQPage",
      mainEntity: FAQS.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ],
};

export function JsonLd() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }}
    />
  );
}
