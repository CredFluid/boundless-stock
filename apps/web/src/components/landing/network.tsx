/**
 * The hero diagram: mirror chains around one home market, with orders flowing in and
 * settlements flowing back. Pure SVG + SMIL, so it costs no JavaScript; packets are hidden for
 * visitors who prefer reduced motion.
 */
const HUB = { x: 300, y: 250 };

const NODES = [
  { x: 92, y: 96, label: "Base", vm: "EVM", use: "DISTRIBUTE" },
  { x: 508, y: 96, label: "Arbitrum", vm: "EVM", use: "TRANSFER" },
  { x: 536, y: 318, label: "Optimism", vm: "EVM", use: "INTEGRATE" },
  { x: 52, y: 330, label: "SVM chain", vm: "SVM", use: "TRADE" },
  { x: 300, y: 462, label: "Any chain", vm: "EVM · SVM", use: "", ghost: true },
];

export function NetworkVisual() {
  return (
    <svg viewBox="0 0 600 520" className="h-auto w-full" role="img"
      aria-label="Solana runs issuance, controls and liquidity; every other chain powers distribution, transfers and integrations.">
      <defs>
        <radialGradient id="hubGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="edge" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--border)" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.6" />
        </linearGradient>
      </defs>

      {/* orbit rings */}
      <circle cx={HUB.x} cy={HUB.y} r="120" fill="none" stroke="var(--border)" strokeDasharray="2 6" />
      <circle cx={HUB.x} cy={HUB.y} r="210" fill="none" stroke="var(--border)" strokeOpacity="0.5" strokeDasharray="2 8" />

      {NODES.map((n, i) => {
        const d = `M${n.x},${n.y} L${HUB.x},${HUB.y}`;
        const back = `M${HUB.x},${HUB.y} L${n.x},${n.y}`;
        return (
          <g key={n.label}>
            {/* A gradient stroke on a vertical line has a zero-width box and draws nothing, so the
                ghost edge (straight down) uses a flat colour. */}
            <path d={d} stroke={n.ghost ? "var(--muted)" : "url(#edge)"} strokeOpacity={n.ghost ? 0.5 : 1} strokeWidth="1.25"
              strokeDasharray={n.ghost ? "4 6" : undefined} fill="none" />
            {/* data flowing along the live edges */}
            {!n.ghost && (
              <path d={d} stroke="var(--accent)" strokeOpacity="0.55" strokeWidth="1.25" strokeDasharray="2 14" fill="none" className="packet">
                <animate attributeName="stroke-dashoffset" from="0" to="-32" dur="1.6s" repeatCount="indefinite" />
              </path>
            )}
            {!n.ghost && (
              <>
                {/* Hidden until their motion starts: before `begin` a packet would sit at the origin. */}
                <circle r="3.5" fill="var(--evm)" className="packet" opacity="0">
                  <set attributeName="opacity" to="1" begin={`${i * 0.55}s`} />
                  <animateMotion dur="2.8s" begin={`${i * 0.55}s`} repeatCount="indefinite" path={d} />
                </circle>
                <circle r="3.5" fill="var(--accent)" className="packet" opacity="0">
                  <set attributeName="opacity" to="1" begin={`${i * 0.55 + 1.4}s`} />
                  <animateMotion dur="2.8s" begin={`${i * 0.55 + 1.4}s`} repeatCount="indefinite" path={back} />
                </circle>
              </>
            )}
          </g>
        );
      })}

      {/* hub, with rings pulsing out of it */}
      <circle cx={HUB.x} cy={HUB.y} r="96" fill="url(#hubGlow)" />
      {[0, 1.3, 2.6].map((begin) => (
        <circle key={begin} cx={HUB.x} cy={HUB.y} r="90" fill="none" stroke="var(--accent)" strokeWidth="1" opacity="0" className="packet">
          <animate attributeName="r" from="90" to="200" dur="3.9s" begin={`${begin}s`} repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.45;0" dur="3.9s" begin={`${begin}s`} repeatCount="indefinite" />
        </circle>
      ))}
      <g>
        <rect x={HUB.x - 122} y={HUB.y - 42} width="244" height="84" rx="16" fill="var(--surface)" stroke="var(--accent)" strokeWidth="1.5" />
        <text x={HUB.x} y={HUB.y - 12} textAnchor="middle" fontSize="11" fill="var(--accent)" letterSpacing="1.5">SOLANA · HOME</text>
        <text x={HUB.x} y={HUB.y + 10} textAnchor="middle" fontSize="15" fontWeight="600" fill="var(--text)">Issuance · Controls · Liquidity</text>
        <text x={HUB.x} y={HUB.y + 28} textAnchor="middle" fontSize="11" fill="var(--muted)">reference market · one ledger</text>
      </g>

      {NODES.map((n) => (
        <g key={`${n.label}-node`}>
          <rect x={n.x - 56} y={n.y - 26} width="112" height="52" rx="12"
            fill="var(--surface)" stroke={n.ghost ? "var(--border)" : "var(--border)"} strokeDasharray={n.ghost ? "4 4" : undefined} />
          <text x={n.x} y={n.y - 2} textAnchor="middle" fontSize="13" fontWeight="600" fill={n.ghost ? "var(--muted)" : "var(--text)"}>{n.label}</text>
          <text x={n.x} y={n.y + 14} textAnchor="middle" fontSize="10" fill={n.vm === "SVM" ? "var(--svm)" : "var(--muted)"} letterSpacing="1">
            {n.ghost ? n.vm : `${n.use} · ${n.vm}`}
          </text>
        </g>
      ))}
    </svg>
  );
}
