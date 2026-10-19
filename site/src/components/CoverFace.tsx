import type { Essay } from "../data/essays";
import { hexLum, inkOn, ribbonColour, withAlpha } from "../lib/essayMeta";
import { COVER_W } from "./bookFaces";

type Props = {
  essay: Essay;
  /** Load the plate image (false keeps far-away spines light). */
  showImage: boolean;
  /** Size multiplier: 1 on the shelf, larger in the detail view (crisp type). */
  u?: number;
  /** Show the "read" bookmark ribbon. */
  read?: boolean;
};

const PAD_X = 13;

/**
 * The front cover, typeset like a Penguin editorial cover:
 * a band-coloured head strip, the title in the display serif, the social
 * image as a framed plate in the middle, and author · publication in small
 * mono at the foot, all in the essay's sampled spine/band palette.
 * Essays without an image get the same layout with a typographic ornament.
 *
 * Laid out at COVER_W × essay.height times `u`. Uses only phrasing elements
 * because it renders inside the spine's <button>.
 */
export function CoverFace({ essay, showImage, u = 1, read = false }: Props) {
  const { spine, ink, title, height: H } = essay;
  const band = essay.band ?? spine;
  const bandInk = inkOn(band);
  // When band and spine are too close, ornaments fall back to a soft ink.
  const accent = Math.abs(hexLum(band) - hexLum(spine)) < 0.12 ? withAlpha(ink, 0.55) : band;
  const issue = Math.max(...essay.issues);
  const hasPlate = Boolean(essay.cover);

  const len = title.length;
  let titleSize = len <= 18 ? 19 : len <= 34 ? 17 : len <= 56 ? 15 : len <= 84 ? 13 : 11.5;
  if (!hasPlate) titleSize *= 1.15;
  const maxLines = len > 84 ? 6 : hasPlate ? 4 : 5;

  const innerW = COVER_W - PAD_X * 2;
  const ratio = essay.coverRatio ?? 1.9;
  const maxPlateH = H * (len > 56 ? 0.29 : 0.35);
  const plateW = Math.min(innerW, maxPlateH * ratio);
  const plateH = plateW / ratio;

  return (
    <span className="absolute inset-0 flex flex-col overflow-hidden" style={{ background: spine, color: ink }}>
      {/* soft tonal light across the board */}
      <span
        className="pointer-events-none absolute inset-0 block"
        style={{
          background:
            "radial-gradient(120% 70% at 28% 18%, rgba(255,255,255,.12), rgba(255,255,255,0) 62%), linear-gradient(180deg, rgba(0,0,0,0) 55%, rgba(0,0,0,.12))",
        }}
      />

      {/* head band */}
      <span
        className="relative flex shrink-0 items-center justify-between font-mono uppercase"
        style={{
          height: 15 * u,
          paddingInline: PAD_X * u,
          background: band,
          color: bandInk,
          fontSize: 5.2 * u,
          letterSpacing: "0.22em",
        }}
      >
        <span>Interesting Reads</span>
        <span>Nº {issue}</span>
      </span>

      <span
        className="relative flex min-h-0 flex-1 flex-col items-center text-center"
        style={{ paddingInline: PAD_X * u, paddingTop: 12 * u, paddingBottom: 9 * u }}
      >
        <span
          className="block font-display font-medium"
          style={{
            fontSize: titleSize * u,
            lineHeight: 1.04,
            letterSpacing: "-0.005em",
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: maxLines,
            overflow: "hidden",
            textWrap: "balance",
          }}
        >
          {title}
        </span>
        <span
          className="block shrink-0"
          style={{ width: 18 * u, height: Math.max(1, u), marginTop: 7 * u, background: accent }}
        />

        <span className="flex min-h-0 w-full flex-1 items-center justify-center" style={{ paddingBlock: 6 * u }}>
          {hasPlate ? (
            <span className="relative block shrink-0" style={{ width: plateW * u, height: plateH * u }}>
              {/* the plate's soft shadow: a gradient, not a box-shadow (cheap on every book) */}
              <span
                aria-hidden="true"
                className="absolute block"
                style={{
                  left: "8%",
                  right: "-3%",
                  bottom: -6 * u,
                  height: 12 * u,
                  background: "radial-gradient(closest-side, rgba(0,0,0,.42), rgba(0,0,0,0))",
                }}
              />
              <span
                className="absolute inset-0 block overflow-hidden"
                style={{
                  background: withAlpha(band, 0.6),
                  outline: `${0.75 * u}px solid ${withAlpha(ink, 0.3)}`,
                }}
              >
                {showImage && essay.cover ? (
                  <img
                    src={essay.cover}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : null}
              </span>
            </span>
          ) : (
            <span className="flex flex-col items-center" style={{ color: accent }}>
              <span className="block" style={{ width: 34 * u, height: Math.max(1, u), background: accent }} />
              <span
                className="block font-mono uppercase"
                style={{ fontSize: 5 * u, letterSpacing: "0.3em", marginTop: 7 * u, opacity: 0.85 }}
              >
                Nº
              </span>
              <span
                className="block font-display font-light italic"
                style={{ fontSize: 46 * u, lineHeight: 0.9, marginTop: u }}
              >
                {issue}
              </span>
              <span
                className="block"
                style={{ width: 34 * u, height: Math.max(1, u), marginTop: 8 * u, background: accent }}
              />
              <span
                className="block"
                style={{ width: 16 * u, height: Math.max(1, u), marginTop: 2.5 * u, background: accent }}
              />
            </span>
          )}
        </span>

        <span
          className="block shrink-0 font-mono uppercase"
          style={{
            fontSize: 5.3 * u,
            lineHeight: 1.5,
            letterSpacing: "0.14em",
            opacity: 0.82,
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 2,
            overflow: "hidden",
          }}
        >
          {essay.author}
          {essay.publication && essay.publication !== essay.author ? ` · ${essay.publication}` : ""}
        </span>
      </span>

      {/* foot band */}
      <span className="relative block shrink-0" style={{ height: 5 * u, background: band }} />

      {read ? <Ribbon colour={ribbonColour(spine, band)} u={u} /> : null}
    </span>
  );
}

/** A bookmark ribbon hanging from the top edge, notched at the tail. */
function Ribbon({ colour, u = 1, right = 16, length = 36, width = 9 }: {
  colour: string;
  u?: number;
  right?: number;
  length?: number;
  width?: number;
}) {
  return (
    <span
      aria-hidden="true"
      data-ribbon=""
      className="absolute block"
      style={{
        top: -1,
        right: right * u,
        width: width * u,
        height: length * u,
        background: `linear-gradient(90deg, rgba(0,0,0,.18), rgba(255,255,255,.12) 45%, rgba(0,0,0,.14)), ${colour}`,
        clipPath: "polygon(0 0, 100% 0, 100% 100%, 50% 80%, 0 100%)",
      }}
    />
  );
}
