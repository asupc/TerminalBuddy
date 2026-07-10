import type { FC, ReactElement } from 'react';
import {
  CIRCLE_RADIUS,
  CIRCLE_STROKE_WIDTH,
  HISTORY_COLORS,
  SWIMLANE_CURVE_RADIUS,
  SWIMLANE_HEIGHT,
  SWIMLANE_WIDTH,
  getHistoryItemIndex,
  getLastOutputSwimlaneIndex,
  type HistoryGraphKind,
  type HistoryGraphViewModel,
} from './gitHistoryGraph';

interface HistoryGraphSvgProps {
  viewModel: HistoryGraphViewModel;
}

const rowBackground = 'var(--git-history-row-bg, #1b1b1b)';

function laneX(index: number): number {
  return SWIMLANE_WIDTH * (index + 1);
}

function renderNodeCircles(kind: HistoryGraphKind, isMerge: boolean, circleX: number, centerY: number, color: string): ReactElement[] {
  if (kind === 'head') {
    return [
      <circle key="head-outer" cx={circleX} cy={centerY} fill={color} r={CIRCLE_RADIUS + 3} stroke={rowBackground} strokeWidth={CIRCLE_STROKE_WIDTH} />,
      <circle key="head-inner" cx={circleX} cy={centerY} fill={rowBackground} r={CIRCLE_STROKE_WIDTH} stroke={rowBackground} strokeWidth={CIRCLE_RADIUS} />,
    ];
  }

  if (kind === 'incoming-changes' || kind === 'outgoing-changes') {
    return [
      <circle key="virtual-outer" cx={circleX} cy={centerY} fill={color} r={CIRCLE_RADIUS + 3} stroke={rowBackground} strokeWidth={CIRCLE_STROKE_WIDTH} />,
      <circle key="virtual-inner" cx={circleX} cy={centerY} fill={rowBackground} r={CIRCLE_RADIUS + 1} stroke={rowBackground} strokeWidth={CIRCLE_STROKE_WIDTH + 1} />,
      <circle
        key="virtual-dashed"
        cx={circleX}
        cy={centerY}
        fill="none"
        r={CIRCLE_RADIUS + 1}
        stroke={color}
        strokeDasharray="4 2"
        strokeWidth={CIRCLE_STROKE_WIDTH - 1}
      />,
    ];
  }

  if (isMerge) {
    return [
      <circle key="merge-outer" cx={circleX} cy={centerY} fill={color} r={CIRCLE_RADIUS + 2} stroke={rowBackground} strokeWidth={CIRCLE_STROKE_WIDTH} />,
      <circle key="merge-inner" cx={circleX} cy={centerY} fill={color} r={CIRCLE_RADIUS - 1} stroke={rowBackground} strokeWidth={CIRCLE_STROKE_WIDTH} />,
    ];
  }

  return [
    <circle key="node" cx={circleX} cy={centerY} fill={color} r={CIRCLE_RADIUS + 1} stroke={rowBackground} strokeWidth={CIRCLE_STROKE_WIDTH} />,
  ];
}

export const HistoryGraphSvg: FC<HistoryGraphSvgProps> = ({ viewModel }) => {
  const { commit, inputSwimlanes, outputSwimlanes } = viewModel;
  const laneCount = Math.max(inputSwimlanes.length, outputSwimlanes.length, 1);
  const width = SWIMLANE_WIDTH * (laneCount + 1);
  const centerY = SWIMLANE_WIDTH;
  const inputIndex = inputSwimlanes.findIndex((node) => node.id === commit.hash);
  const circleIndex = getHistoryItemIndex(viewModel);
  const circleX = laneX(circleIndex);
  const circleColor = outputSwimlanes[circleIndex]?.color
    ?? inputSwimlanes[circleIndex]?.color
    ?? HISTORY_COLORS.local;
  const paths: ReactElement[] = [];

  const addPath = (key: string, d: string, color: string, strokeWidth = 1) => {
    paths.push(
      <path
        key={key}
        d={d}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />,
    );
  };

  let outputSwimlaneIndex = 0;
  for (let index = 0; index < inputSwimlanes.length; index += 1) {
    const inputNode = inputSwimlanes[index];
    const color = inputNode.color;

    if (inputNode.id === commit.hash) {
      if (index !== circleIndex) {
        addPath(
          `base-${commit.hash}-${index}`,
          [
            `M ${laneX(index)} 0`,
            `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${centerY}`,
            `H ${circleX}`,
          ].join(' '),
          color,
        );
      } else {
        outputSwimlaneIndex += 1;
      }
    } else if (
      outputSwimlaneIndex < outputSwimlanes.length
      && inputNode.id === outputSwimlanes[outputSwimlaneIndex].id
    ) {
      if (index === outputSwimlaneIndex) {
        addPath(`lane-${inputNode.id}-${index}`, `M ${laneX(index)} 0 V ${SWIMLANE_HEIGHT}`, color);
      } else {
        addPath(
          `lane-${inputNode.id}-${index}-${outputSwimlaneIndex}`,
          [
            `M ${laneX(index)} 0`,
            'V 6',
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${laneX(index) - SWIMLANE_CURVE_RADIUS} ${centerY}`,
            `H ${laneX(outputSwimlaneIndex) + SWIMLANE_CURVE_RADIUS}`,
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${laneX(outputSwimlaneIndex)} ${centerY + SWIMLANE_CURVE_RADIUS}`,
            `V ${SWIMLANE_HEIGHT}`,
          ].join(' '),
          color,
        );
      }

      outputSwimlaneIndex += 1;
    }
  }

  for (let i = 1; i < commit.parents.length; i += 1) {
    const parentOutputIndex = getLastOutputSwimlaneIndex(viewModel, commit.parents[i]);
    if (parentOutputIndex === -1) continue;

    addPath(
      `parent-${commit.hash}-${commit.parents[i]}-${i}`,
      [
        `M ${SWIMLANE_WIDTH * parentOutputIndex} ${centerY}`,
        `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${laneX(parentOutputIndex)} ${SWIMLANE_HEIGHT}`,
        `M ${SWIMLANE_WIDTH * parentOutputIndex} ${centerY}`,
        `H ${circleX}`,
      ].join(' '),
      outputSwimlanes[parentOutputIndex].color,
    );
  }

  if (inputIndex !== -1) {
    addPath(`in-${commit.hash}`, `M ${circleX} 0 V ${SWIMLANE_HEIGHT / 2}`, inputSwimlanes[inputIndex].color);
  }

  if (commit.parents.length > 0) {
    addPath(`out-${commit.hash}`, `M ${circleX} ${SWIMLANE_HEIGHT / 2} V ${SWIMLANE_HEIGHT}`, circleColor);
  }

  return (
    <svg
      aria-hidden="true"
      className="git-history-graph-svg"
      height={SWIMLANE_HEIGHT}
      viewBox={`0 0 ${width} ${SWIMLANE_HEIGHT}`}
      width={width}
    >
      {paths}
      {renderNodeCircles(viewModel.kind, commit.parents.length > 1, circleX, centerY, circleColor)}
    </svg>
  );
};
