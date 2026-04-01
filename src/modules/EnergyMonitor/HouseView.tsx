import { useMemo } from 'react'

interface ChannelUsage {
  name: string
  watts: number
  kwh: number
  percentage: number
  type: string
  deviceName: string
}

const ROOM_CIRCUITS: Record<string, string[]> = {
  'Master Bedroom': ['Master Bedroom/Hallway Lights', 'Master/Basement Lights', 'Master/Basement Plugs'],
  'Master Bath': ['Towel Warmer', 'Bathroom plugs & Entry Lights'],
  'Office Upper': ['Living/Hallway Lights'],
  'Entry': ['Bathroom plugs & Entry Lights'],
  'Living Room': ['Living/Hallway Lights'],
  'Kitchen': ['Hood Fan', 'Island Disposal', 'Dishwasher', 'Appliances', 'Range', 'Oven', 'Freezer'],
  'Dining Room': ['Dining Lights'],
  'Pantry': ['Appliances'],
  'Laundry': ['Washer', 'Dryer', 'Iron Board'],
  'Family Room': ['Master/Basement Lights', 'Master/Basement Plugs'],
  'Office Lower': ['Two Beds by Panels'],
  'Bedroom 3': ['Two Beds by Panels'],
  'Bedroom 4': ['Two Beds by Panels'],
  'Bathroom Lower': ['Bathroom Lower Plugs'],
  'HVAC': ['Furnace', 'Heat Pump'],
  'Water Systems': ['Water Heater', 'Water Pump', 'Water Control'],
}

function getRoomPower(roomId: string, circuits: ChannelUsage[]): number {
  const mapped = ROOM_CIRCUITS[roomId]
  if (!mapped) return 0
  let total = 0
  for (const c of circuits) {
    if (mapped.some(m => c.name.includes(m) || m.includes(c.name))) {
      total += c.watts
    }
  }
  return total
}

// Scale: 1 foot = 5 SVG units
const S = 5

// Rooms defined as POLYGONS traced from blueprint walls
// Coordinates in feet, [x, y] where x=right, y=down
// Each floor has its own coordinate origin at its top-left extent
interface RoomPoly {
  id: string
  label: string
  points: [number, number][]
  outdoor?: boolean
  labelPos?: [number, number] // override label position
}

// ================================================================
// LOWER FLOOR — 1,306 sf — L-shaped outline
// The right wing extends ~8' further north than the left wing
// Total: left wing 18'×23' + right wing 26'×31'
// From blueprints: Family Rm left, Office/Bedrooms center-right,
// Bath upper-right, Stairs upper-center, Patio across front
// ================================================================

// Outline: L-shape. Left starts at y=8, right starts at y=0
// Width: 44', Depth: 31' (right side), 23' (left side from y=8)
const LOWER_OUTLINE: [number, number][] = [
  [0, 8], [18, 8], [18, 0], [44, 0], [44, 31], [0, 31],
]

const LOWER_ROOMS: RoomPoly[] = [
  // === Upper-right wing (y=0 to 8, x=18 to 44) ===
  // Stairs coming down from main floor
  { id: 'Stairs Lower', label: 'Stairs', points: [[18,0],[26,0],[26,8],[18,8]] },
  // Hall / R&S area
  { id: 'Hall Upper-R', label: 'Hall', points: [[26,0],[33,0],[33,5],[26,5]] },
  // Closet (bi-pass)
  { id: 'Closet Upper', label: 'Closet', points: [[26,5],[33,5],[33,8],[26,8]] },
  // Bathroom with tub/shower
  { id: 'Bathroom Lower', label: 'Bathroom', points: [[33,0],[44,0],[44,10],[33,10]] },

  // === Left wing (x=0 to 18, y=8 to 31) ===
  // Family Room — large open room
  { id: 'Family Room', label: 'Family Room', points: [[0,8],[18,8],[18,22],[0,22]] },
  // Laundry
  { id: 'Laundry Lower', label: 'Laundry', points: [[0,22],[8,22],[8,31],[0,31]] },
  // Hall / utility bottom-left
  { id: 'Hall Lower', label: 'Hall', points: [[8,22],[18,22],[18,31],[8,31]] },

  // === Center column (x=18 to 32, y=8 to 31) ===
  // Office
  { id: 'Office Lower', label: 'Office', points: [[18,8],[32,8],[32,18],[18,18]] },
  // Bedroom 3
  { id: 'Bedroom 3', label: 'Bedroom 3', points: [[18,18],[32,18],[32,31],[18,31]] },

  // === Right column (x=32 to 44, y=10 to 31) ===
  // Bedroom 4
  { id: 'Bedroom 4', label: 'Bedroom 4', points: [[33,10],[44,10],[44,24],[33,24]] },
  // Closet / storage bottom-right
  { id: 'Storage Lower', label: 'Storage', points: [[32,24],[44,24],[44,31],[32,31]] },

  // === Patio — extends wider than house ===
  { id: 'Patio', label: 'Patio', points: [[-3,31],[47,31],[47,36],[-3,36]], outdoor: true },
]

// ================================================================
// MAIN FLOOR — 1,079 sf — Irregular with wrap-around deck
// The enclosed area has a step: right side is 4' shorter depth
// Deck wraps rear (north) and left (west) sides
// ================================================================

// Outline: step on bottom-right
const MAIN_OUTLINE: [number, number][] = [
  [0, 0], [36, 0], [36, 26], [24, 26], [24, 30], [0, 30],
]

const MAIN_ROOMS: RoomPoly[] = [
  // Wood deck — wraps rear and left side (outdoor L-shape)
  { id: 'Deck Rear', label: 'Wood Deck', points: [[-4,-4],[40,-4],[40,0],[-4,0]], outdoor: true },
  { id: 'Deck Left', label: 'Deck', points: [[-4,0],[0,0],[0,24],[-4,24]], outdoor: true },

  // Living Room — upper-left
  { id: 'Living Room', label: 'Living Room', points: [[0,0],[14,0],[14,13],[0,13]] },
  // Kitchen — center with island
  { id: 'Kitchen', label: 'Kitchen', points: [[14,0],[26,0],[26,12],[14,12]] },
  // Pantry — right of kitchen, smaller
  { id: 'Pantry', label: 'Pantry', points: [[26,0],[32,0],[32,6],[26,6]] },
  // Dining Room — right side, extends to the step
  { id: 'Dining Room', label: 'Dining\nRoom', points: [[26,6],[36,6],[36,18],[26,18]] },

  // Hall / stairs center
  { id: 'Stairs Main', label: 'Stairs', points: [[14,12],[19,12],[19,18],[14,18]] },
  // Entry
  { id: 'Entry', label: 'Entry', points: [[19,12],[26,12],[26,18],[19,18]] },
  // Coat closet
  { id: 'Coat', label: 'Coat', points: [[32,6],[36,6],[36,0],[32,0]], labelPos: [34,3] },
  // Nook area between dining and entry
  { id: 'AC Main', label: 'A/C', points: [[26,18],[32,18],[32,22],[26,22]] },

  // Laundry
  { id: 'Laundry', label: 'Laundry', points: [[32,18],[36,18],[36,26],[32,26]] },
  // Powder room
  { id: 'Powder Room', label: 'Powder\nRoom', points: [[26,22],[32,22],[32,26],[24,26],[24,30],[26,30]], labelPos: [28,26] },

  // Front porch — bottom-left outdoor area
  { id: 'Front Porch', label: 'Front Porch', points: [[0,13],[14,13],[14,18],[0,18]], outdoor: true },
  // Lower front
  { id: 'Patio Main', label: 'Patio', points: [[0,18],[14,18],[14,30],[24,30],[24,26],[19,26],[19,18],[14,18],[0,18],[0,30]], outdoor: true },
]

// ================================================================
// UPPER FLOOR — 690 sf — Smaller, irregular outline
// Master bedroom dominates the left, office top-right
// Bath at top, stairs center, balcony projects from front
// Step: top portion is wider (includes office), bottom narrows
// ================================================================

// Outline: wider at top (office), narrows at bottom (closets)
const UPPER_OUTLINE: [number, number][] = [
  [0, 0], [25, 0], [25, 18], [22, 18], [22, 25], [0, 25],
]

const UPPER_ROOMS: RoomPoly[] = [
  // Master Bedroom — large left room
  { id: 'Master Bedroom', label: 'Master\nBedroom', points: [[0,0],[14,0],[14,15],[0,15]] },
  // Master Bath — right of bedroom top
  { id: 'Master Bath', label: 'Master\nBath', points: [[14,0],[22,0],[22,9],[14,9]] },
  // Vaulted Office — top-right with angular wall
  { id: 'Office Upper', label: 'Vaulted\nOffice', points: [[22,0],[25,0],[25,9],[22,9],[22,0]] },
  // Office continues - actually, let me make it a larger L-shape area
  // Landing / stair area
  { id: 'Stairs Upper', label: 'Stairs', points: [[14,9],[19,9],[19,15],[14,15]] },
  // Hall
  { id: 'Hall Upper', label: 'Hall', points: [[19,9],[25,9],[25,18],[22,18],[22,15],[19,15]], labelPos: [22,13] },
  // Walk-in Closet
  { id: 'WIC', label: 'W.I.C', points: [[0,15],[7,15],[7,20],[0,20]] },
  // Coffered closets
  { id: 'Closet Upper', label: 'Closet', points: [[7,15],[14,15],[14,20],[7,20]] },
  // A/C
  { id: 'AC Upper', label: 'A/C', points: [[14,15],[18,15],[18,18],[14,18]] },
  // Small landing
  { id: 'Landing Upper', label: '', points: [[18,15],[22,15],[22,18],[18,18]] },
  // Hallway to stairs
  { id: 'Lower Hall', label: 'Hall', points: [[0,20],[22,20],[22,25],[0,25]] },

  // Balcony — projects from front (south), only on bedroom side
  { id: 'Balcony', label: 'Balcony', points: [[0,25],[22,25],[22,29],[0,29]], outdoor: true },
]

// ================================================================

interface HouseViewProps {
  circuits: ChannelUsage[]
  totalWatts: number
}

export default function HouseView({ circuits, totalWatts }: HouseViewProps) {
  const roomPowers = useMemo(() => {
    const powers: Record<string, number> = {}
    for (const room of [...LOWER_ROOMS, ...MAIN_ROOMS, ...UPPER_ROOMS]) {
      powers[room.id] = getRoomPower(room.id, circuits)
    }
    return powers
  }, [circuits])

  const maxPower = useMemo(() => Math.max(...Object.values(roomPowers), 100), [roomPowers])

  function polyToString(points: [number, number][], ox: number, oy: number): string {
    return points.map(([x, y]) => `${ox + x * S},${oy + y * S}`).join(' ')
  }

  function polyCenter(points: [number, number][]): [number, number] {
    const cx = points.reduce((s, p) => s + p[0], 0) / points.length
    const cy = points.reduce((s, p) => s + p[1], 0) / points.length
    return [cx, cy]
  }

  function polySize(points: [number, number][]): [number, number] {
    const xs = points.map(p => p[0])
    const ys = points.map(p => p[1])
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
  }

  function renderFloor(
    rooms: RoomPoly[],
    outline: [number, number][],
    floorLabel: string,
    ox: number, oy: number,
  ) {
    return (
      <g key={floorLabel}>
        {/* Floor outline */}
        <polygon
          points={polyToString(outline, ox, oy)}
          fill="rgba(0,0,0,0.2)"
          stroke="rgba(0,255,255,0.12)"
          strokeWidth={1}
          strokeLinejoin="round"
        />

        {/* Rooms */}
        {rooms.map(room => {
          const power = roomPowers[room.id] || 0
          const intensity = Math.min(1, power / Math.max(maxPower * 0.35, 120))
          const isActive = power >= 1
          const isOutdoor = !!room.outdoor
          const [w, h] = polySize(room.points)

          const fillColor = isOutdoor
            ? isActive
              ? `rgba(0, 200, 100, ${0.03 + intensity * 0.1})`
              : 'rgba(255,255,255,0.01)'
            : isActive
              ? `rgba(0, 255, 120, ${0.05 + intensity * 0.45})`
              : 'rgba(255,255,255,0.02)'

          const strokeColor = isActive
            ? `rgba(0, 255, 120, ${0.2 + intensity * 0.6})`
            : 'rgba(255,255,255,0.05)'

          const [cx, cy] = room.labelPos || polyCenter(room.points)
          const lines = room.label.split('\n').filter(Boolean)
          const fontSize = (w < 4 || h < 4) ? 5 : w < 7 ? 6 : w < 10 ? 7 : 8

          return (
            <g key={room.id}>
              <polygon
                points={polyToString(room.points, ox, oy)}
                fill={fillColor}
                stroke={strokeColor}
                strokeWidth={isActive ? 0.8 : 0.3}
                strokeLinejoin="round"
                style={{ transition: 'fill 0.8s ease, stroke 0.5s ease' }}
              />
              {isActive && !isOutdoor && (
                <polygon
                  points={polyToString(room.points, ox, oy)}
                  fill="none"
                  stroke={`rgba(0, 255, 120, ${intensity * 0.3})`}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  filter="url(#glow)"
                  style={{ transition: 'stroke 0.8s ease' }}
                />
              )}
              {/* Label */}
              {w > 3 && h > 3 && lines.map((line, li) => (
                <text key={li}
                  x={ox + cx * S}
                  y={oy + cy * S + (li - (lines.length - 1) / 2) * (fontSize + 1) - (isActive && h > 6 ? 2.5 : 0)}
                  textAnchor="middle" dominantBaseline="central"
                  fill={isActive ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.2)'}
                  fontSize={fontSize}
                  fontFamily="'SF Mono', 'Fira Code', monospace"
                  letterSpacing="0.2"
                  style={{ transition: 'fill 0.5s ease', pointerEvents: 'none' }}
                >
                  {line}
                </text>
              ))}
              {/* Watts */}
              {isActive && h > 6 && w > 5 && (
                <text
                  x={ox + cx * S}
                  y={oy + cy * S + lines.length * (fontSize / 2) + 4}
                  textAnchor="middle" dominantBaseline="central"
                  fill="rgba(0,255,200,0.55)" fontSize={5}
                  fontFamily="'SF Mono', 'Fira Code', monospace"
                  style={{ pointerEvents: 'none' }}
                >
                  {power >= 1000 ? `${(power / 1000).toFixed(1)}kW` : `${Math.round(power)}W`}
                </text>
              )}
            </g>
          )
        })}

        {/* Floor label */}
        <text
          x={ox - 10} y={oy + polyCenter(outline)[1] * S}
          textAnchor="middle" dominantBaseline="central"
          fill="rgba(0,255,255,0.35)" fontSize={7}
          fontFamily="'SF Mono', 'Fira Code', monospace"
          letterSpacing="1.5"
          transform={`rotate(-90, ${ox - 10}, ${oy + polyCenter(outline)[1] * S})`}
        >
          {floorLabel}
        </text>
      </g>
    )
  }

  // Vertical spacing
  const gap = 12
  const baseX = 25

  // Floor bounding heights (in SVG units)
  const upperH = 29 * S // includes balcony
  const mainH = 34 * S  // includes deck
  const lowerH = 36 * S // includes patio

  const upperY = 8
  const mainY = upperY + upperH + gap
  const lowerY = mainY + mainH + gap

  // Center the upper floor (narrower) relative to the wider lower floor
  const lowerWidth = 44
  const mainWidth = 36
  const upperWidth = 25
  const mainOx = baseX + ((lowerWidth - mainWidth) / 2) * S
  const upperOx = baseX + ((lowerWidth - upperWidth) / 2) * S

  const svgW = lowerWidth * S + 70
  const svgH = lowerY + lowerH + 10

  return (
    <div className="house-view">
      <div className="house-view-header">
        <span className="house-view-total">
          {totalWatts >= 1000 ? `${(totalWatts / 1000).toFixed(1)} kW` : `${Math.round(totalWatts)} W`}
        </span>
        <span className="energy-live-dot" />
        <span className="house-view-label">LIVE HOUSE VIEW</span>
      </div>
      <div className="house-view-svg-wrap">
        <svg viewBox={`-5 0 ${svgW} ${svgH}`} className="house-view-svg" preserveAspectRatio="xMidYMid meet">
          <defs>
            <filter id="glow">
              <feGaussianBlur stdDeviation="2" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <g transform="skewY(-1)">
            {renderFloor(UPPER_ROOMS, UPPER_OUTLINE, 'UPPER', upperOx, upperY)}

            {/* Connector lines upper → main */}
            <line x1={upperOx} y1={upperY + upperH - 4} x2={upperOx} y2={mainY + 4}
              stroke="rgba(0,255,255,0.06)" strokeWidth={0.5} strokeDasharray="2 3" />
            <line x1={upperOx + upperWidth * S} y1={upperY + upperH - 4} x2={upperOx + upperWidth * S} y2={mainY + 4}
              stroke="rgba(0,255,255,0.06)" strokeWidth={0.5} strokeDasharray="2 3" />

            {renderFloor(MAIN_ROOMS, MAIN_OUTLINE, 'MAIN', mainOx, mainY)}

            {/* Connector lines main → lower */}
            <line x1={mainOx} y1={mainY + mainH - 4} x2={baseX} y2={lowerY + 4}
              stroke="rgba(0,255,255,0.06)" strokeWidth={0.5} strokeDasharray="2 3" />
            <line x1={mainOx + mainWidth * S} y1={mainY + mainH - 4} x2={baseX + lowerWidth * S} y2={lowerY + 4}
              stroke="rgba(0,255,255,0.06)" strokeWidth={0.5} strokeDasharray="2 3" />

            {renderFloor(LOWER_ROOMS, LOWER_OUTLINE, 'LOWER', baseX, lowerY)}
          </g>
        </svg>
      </div>

      <div className="house-view-legend">
        <div className="house-view-legend-item">
          <div className="house-view-legend-swatch house-view-legend--active" />
          <span>Active</span>
        </div>
        <div className="house-view-legend-item">
          <div className="house-view-legend-swatch house-view-legend--off" />
          <span>Off</span>
        </div>
        <div className="house-view-legend-item house-view-legend-total">
          {Object.entries(roomPowers).filter(([, w]) => w >= 1).length} rooms active
        </div>
      </div>
    </div>
  )
}
