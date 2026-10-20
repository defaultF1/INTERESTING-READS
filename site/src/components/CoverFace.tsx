import type { Essay } from "../data/essays";
import { bookStyle, wavePathD } from "../lib/bookStyle";
import { ribbonColour, withAlpha } from "../lib/essayMeta";
import { FONT } from "../shelf3d/fonts";
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
 * The front cover in the page (the plain shelf, or a desk opened before the 3D shelf is up):
 * the same design as the 3D shelf's baked cover (src/shelf3d/bake.ts drawCover): the
 * jacket's flat colour and soft waves, "Interesting Reads" and "#N" at the head, the title
 * in the serif, the essay's image as an inset panel, author · publication in tracked
 * capitals on the foot. Essays without an image show the issue number large instead.
 *
 * Laid out at COVER_W × essay.height times `u`. Uses only phrasing elements
 * because it renders inside the spine's <button>.
 */
export function CoverFace({ essay, showImage, u = 1, read = false }: Props) {
  const { title, height: H } = essay;
  const st = bookStyle(essay);
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
    <span className="absolute inset-0 flex flex-col overflow-hidden" style={{ background: st.base, color: st.ink }}>
      <svg aria-hidden="true" className="absolute inset-0 h-full w-full" viewBox={`0 0 ${COVER_W} ${H}`} preserveAspectRatio="none">
        {st.waves.map((w, i) => (
          <path key={i} d={wavePathD(w, COVER_W, H)} fill={w.colour} />
        ))}
      </svg>

      {/* head: the series and the issue */}
      <span
        className="relative flex shrink-0 items-center justify-between uppercase"
        style={{ height: 20 * u, paddingInline: PAD_X * u, color: st.headInk, fontFamily: FONT.sans, fontWeight: 500, fontSize: 5.2 * u, letterSpacing: "0.24em", opacity: 0.86 }}
      >
        <span>Interesting Reads</span>
        <span style={{ fontFamily: FONT.serif, fontWeight: FONT.markerWeight, fontSize: 7 * u, letterSpacing: 0, textTransform: "none" }}>#{issue}</span>
      </span>

      <span
        className="relative flex min-h-0 flex-1 flex-col items-center text-center"
        style={{ paddingInline: PAD_X * u, paddingTop: Math.max(2, H * st.headBottom + 8 - 20) * u, paddingBottom: 10 * u }}
      >
        <span
          className="block"
          style={{
            fontFamily: FONT.serif,
            fontWeight: 500,
            fontSize: titleSize * u,
            lineHeight: 1.06,
            letterSpacing: "-0.01em",
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: maxLines,
            overflow: "hidden",
            textWrap: "balance",
          }}
        >
          {title}
        </span>

        <span className="flex min-h-0 w-full flex-1 items-center justify-center" style={{ paddingBlock: 8 * u }}>
          {hasPlate ? (
            <span
              className="relative block shrink-0 overflow-hidden"
              style={{ width: plateW * u, height: plateH * u, background: withAlpha(st.accent, 0.7), outline: `${0.6 * u}px solid ${withAlpha(st.ink, 0.35)}` }}
            >
              {showImage && essay.cover ? (
                <img src={essay.cover} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
              ) : null}
            </span>
          ) : (
            <span className="block" style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: 44 * u, lineHeight: 1, letterSpacing: "-0.02em" }}>
              #{issue}
            </span>
          )}
        </span>

        <span
          className="block shrink-0 uppercase"
          style={{
            color: st.footInk,
            fontFamily: FONT.sans,
            fontWeight: 500,
            fontSize: 5.3 * u,
            lineHeight: 1.5,
            letterSpacing: "0.16em",
            opacity: 0.9,
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

      {read ? <Ribbon colour={ribbonColour(st.base, st.accent)} u={u} /> : null}
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
