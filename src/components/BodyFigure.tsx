import { useId } from 'react';
import { Platform, View } from 'react-native';
import Svg, { ClipPath, Defs, G, Path, Text as SvgText } from 'react-native-svg';

import { AppColors } from '@/constants/appTheme';
import { BODY_ZONE_LABELS, type BodySide } from '@/constants/bodyZones';
import {
  FIGURE_VIEWBOX,
  LR_GLYPHS,
  regionsFor,
  silhouettePath,
  type BodySex,
} from '@/constants/bodyFigure';
import { BodyZone } from '@/decision/types';

type BodyFigureProps = {
  side: BodySide;
  sex: BodySex;
  selectedZone: BodyZone | null;
  onSelect: (zone: BodyZone) => void;
  /** Cap on the drawn width; the figure always keeps its aspect ratio. */
  maxWidth: number;
};

const UNSELECTED_FILL = '#C7D3E3';
const SEAM = '#FFFFFF';

/**
 * One body view. Each region path is its own hit target, so a tap can never
 * land somewhere other than where it was drawn -- there is a single
 * coordinate system and nothing to keep in sync.
 *
 * Never give an Svg child an accessibilityRole: react-native-web swaps the
 * element tag for mapped roles, and a <button> inside an <svg> renders
 * invisible and unclickable.
 */
export function BodyFigure({ side, sex, selectedZone, onSelect, maxWidth }: BodyFigureProps) {
  // Must be stable across server render and hydration (the web build prerenders
  // this screen), and free of the punctuation useId() adds -- a colon inside
  // url(#...) is not reliably parseable.
  const clipId = `body-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  const regions = regionsFor(side);
  const outline = silhouettePath(side, sex);
  const glyphs = LR_GLYPHS[side];

  return (
    <View
      style={{
        width: '100%',
        maxWidth,
        aspectRatio: FIGURE_VIEWBOX.width / FIGURE_VIEWBOX.height,
        alignSelf: 'center',
      }}>
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${FIGURE_VIEWBOX.width} ${FIGURE_VIEWBOX.height}`}
        accessibilityLabel="Body diagram. Tap the area where the wound is.">
        <Defs>
          <ClipPath id={clipId}>
            <Path d={outline} />
          </ClipPath>
        </Defs>

        {/* Regions bleed past the body edge and are clipped back to it, so the
            outline can never show a gap between two regions. */}
        <G clipPath={`url(#${clipId})`}>
          {regions.map((region) => {
            const selected = region.id === selectedZone;
            const shape = {
              d: region.d,
              fill: selected ? AppColors.teal : UNSELECTED_FILL,
              stroke: SEAM,
              strokeWidth: 1.4,
            };

            // On web, react-native-svg turns onPress into a DOM onClick anyway,
            // but it also forwards six React Native responder props onto the
            // <path>, which React DOM warns about six times per region. Going
            // straight to a DOM path skips that entirely; the <g> wrapper above
            // is still react-native-svg, so clipping is unaffected.
            return Platform.OS === 'web' ? (
              <path
                key={region.id}
                {...shape}
                onClick={() => onSelect(region.id)}
                aria-label={BODY_ZONE_LABELS[region.id]}
              />
            ) : (
              <Path
                key={region.id}
                {...shape}
                onPress={() => onSelect(region.id)}
                accessibilityLabel={BODY_ZONE_LABELS[region.id]}
                accessible
              />
            );
          })}
        </G>

        {/* Drawn over the regions, so on web its stroke has to be excused from
            hit testing or it would swallow clicks landing on the body edge. On
            native a shape with no press handler is not hit-tested at all. */}
        {Platform.OS === 'web' ? (
          <path
            d={outline}
            fill="none"
            stroke={AppColors.navy}
            strokeWidth={2}
            strokeOpacity={0.8}
            style={{ pointerEvents: 'none' }}
          />
        ) : (
          <Path d={outline} fill="none" stroke={AppColors.navy} strokeWidth={2} strokeOpacity={0.8} />
        )}

        {/* These swap sides with the view -- that is the point of drawing them. */}
        <SvgText
          x={glyphs.left[0]}
          y={glyphs.left[1]}
          fontSize={17}
          fontWeight="700"
          textAnchor="middle"
          fill={AppColors.textSecondary}>
          L
        </SvgText>
        <SvgText
          x={glyphs.right[0]}
          y={glyphs.right[1]}
          fontSize={17}
          fontWeight="700"
          textAnchor="middle"
          fill={AppColors.textSecondary}>
          R
        </SvgText>
      </Svg>
    </View>
  );
}
