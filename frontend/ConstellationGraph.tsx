'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ArticleNode, RouteVariant, SearchResult } from './lib/types';

interface ConstellationGraphProps {
  result: SearchResult;
  onNodeClick?: (node: ArticleNode) => void;
  onTopAnchorChange?: (topNodeY: number) => void;
  wireSpeed?: number;
  nodeDrift?: number;
  isCompactLayout?: boolean;
}

interface GraphNode {
  key: string;
  node: ArticleNode;
  depth: number;
  routeHits: number;
}

interface GraphEdge {
  key: string;
  fromKey: string;
  toKey: string;
  routeHits: number;
}

interface PhysicsNode {
  key: string;
  baseX: number;
  baseY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  floatPhaseX: number;
  floatPhaseY: number;
  floatFreqX: number;
  floatFreqY: number;
  isDragging: boolean;
  adjacentIndices: number[];
  pullX: number;
  pullY: number;
  pullVX: number;
  pullVY: number;
}

const W = 1200;
const H = 700;
const FLOAT_AMP = 5;
const SPRING_K = 0.06;
const SPRING_D = 0.82;
const DRAG_CLICK_THRESHOLD = 8;
const FRAME_PADDING_X = 124;
const MAX_NODE_TEXT_WIDTH = 188;
const MAX_SPECIAL_NODE_TEXT_WIDTH = 150;

function estimateTextWidth(text: string): number {
  return text.length * 6.9;
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function wrapNodeTitle(title: string, maxWidth: number): string[] {
  const maxChars = Math.max(10, Math.floor(maxWidth / 7.4));
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [''];
  }

  const lines: string[] = [];
  let currentLine = '';

  const pushLine = (line: string) => {
    if (!line) {
      return;
    }
    lines.push(line);
  };

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (estimateTextWidth(candidate) <= maxWidth && candidate.length <= maxChars) {
      currentLine = candidate;
      continue;
    }

    if (!currentLine) {
      pushLine(truncateWithEllipsis(word, maxChars));
      continue;
    }

    pushLine(currentLine);
    currentLine = word;
    if (lines.length === 1 && estimateTextWidth(currentLine) > maxWidth) {
      currentLine = truncateWithEllipsis(currentLine, maxChars);
    }

    if (lines.length >= 2) {
      break;
    }
  }

  if (lines.length < 2 && currentLine) {
    pushLine(currentLine);
  }

  if (lines.length > 2) {
    lines.length = 2;
  }

  if (lines.length === 2) {
    lines[1] = truncateWithEllipsis(lines[1]!, maxChars);
  }

  return lines;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function orderColumns(
  columns: GraphNode[][],
  edges: GraphEdge[],
  maxDepth: number
): GraphNode[][] {
  const nextKeysByKey = new Map<string, string[]>();
  const previousKeysByKey = new Map<string, string[]>();

  for (const edge of edges) {
    const next = nextKeysByKey.get(edge.fromKey) ?? [];
    next.push(edge.toKey);
    nextKeysByKey.set(edge.fromKey, next);

    const previous = previousKeysByKey.get(edge.toKey) ?? [];
    previous.push(edge.fromKey);
    previousKeysByKey.set(edge.toKey, previous);
  }

  const ordered = columns.map((column) => [...column]);

  const sortByNeighborPositions = (
    depth: number,
    neighborKeysByKey: Map<string, string[]>,
    neighborDepth: number
  ): void => {
    const column = ordered[depth];
    const neighborColumn = ordered[neighborDepth];
    if (!column || column.length <= 1 || !neighborColumn || neighborColumn.length === 0) {
      return;
    }

    const neighborIndexByKey = new Map(
      neighborColumn.map((graphNode, index) => [graphNode.key, index])
    );
    const currentIndexByKey = new Map(column.map((graphNode, index) => [graphNode.key, index]));

    column.sort((left, right) => {
      const leftNeighborIndexes =
        neighborKeysByKey
          .get(left.key)
          ?.map((key) => neighborIndexByKey.get(key))
          .filter((value): value is number => value !== undefined) ?? [];
      const rightNeighborIndexes =
        neighborKeysByKey
          .get(right.key)
          ?.map((key) => neighborIndexByKey.get(key))
          .filter((value): value is number => value !== undefined) ?? [];

      const leftAverage = average(leftNeighborIndexes);
      const rightAverage = average(rightNeighborIndexes);

      if (leftAverage !== null && rightAverage !== null && leftAverage !== rightAverage) {
        return leftAverage - rightAverage;
      }
      if (leftAverage !== null && rightAverage === null) {
        return -1;
      }
      if (leftAverage === null && rightAverage !== null) {
        return 1;
      }

      const leftCurrent = currentIndexByKey.get(left.key) ?? 0;
      const rightCurrent = currentIndexByKey.get(right.key) ?? 0;
      if (leftCurrent !== rightCurrent) {
        return leftCurrent - rightCurrent;
      }
      if (left.routeHits !== right.routeHits) {
        return right.routeHits - left.routeHits;
      }
      return left.node.displayTitle.localeCompare(right.node.displayTitle);
    });
  };

  for (let pass = 0; pass < 6; pass += 1) {
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      sortByNeighborPositions(depth, previousKeysByKey, depth - 1);
    }

    for (let depth = maxDepth - 1; depth >= 0; depth -= 1) {
      sortByNeighborPositions(depth, nextKeysByKey, depth + 1);
    }
  }

  return ordered;
}

function buildGraph(result: SearchResult): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: Array<{ x: number; y: number }>;
} {
  const routes: RouteVariant[] =
    result.routes.length > 0 ? result.routes : [{ routeIndex: 0, path: result.path }];
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();

  for (const route of routes) {
    route.path.forEach((node, index) => {
      const depth = node.distanceFromStart ?? index;
      const key = `${node.articleId}:${depth}`;
      const existing = nodeMap.get(key);
      if (existing) {
        existing.routeHits += 1;
      } else {
        nodeMap.set(key, {
          key,
          node,
          depth,
          routeHits: 1
        });
      }
    });

    for (let index = 0; index < route.path.length - 1; index += 1) {
      const from = route.path[index]!;
      const to = route.path[index + 1]!;
      const fromDepth = from.distanceFromStart ?? index;
      const toDepth = to.distanceFromStart ?? index + 1;
      const fromKey = `${from.articleId}:${fromDepth}`;
      const toKey = `${to.articleId}:${toDepth}`;
      const edgeKey = `${fromKey}->${toKey}`;
      const existing = edgeMap.get(edgeKey);
      if (existing) {
        existing.routeHits += 1;
      } else {
        edgeMap.set(edgeKey, {
          key: edgeKey,
          fromKey,
          toKey,
          routeHits: 1
        });
      }
    }
  }

  const nodes = Array.from(nodeMap.values());
  nodes.sort((left, right) => {
    if (left.depth !== right.depth) {
      return left.depth - right.depth;
    }
    if (left.node.isStart !== right.node.isStart) {
      return left.node.isStart ? -1 : 1;
    }
    if (left.node.isEnd !== right.node.isEnd) {
      return left.node.isEnd ? 1 : -1;
    }
    if (left.routeHits !== right.routeHits) {
      return right.routeHits - left.routeHits;
    }
    return left.node.displayTitle.localeCompare(right.node.displayTitle);
  });

  const edges = Array.from(edgeMap.values());
  const maxDepth = Math.max(...nodes.map((entry) => entry.depth), 0);
  const columns = new Map<number, GraphNode[]>();
  for (const graphNode of nodes) {
    const bucket = columns.get(graphNode.depth) ?? [];
    bucket.push(graphNode);
    columns.set(graphNode.depth, bucket);
  }

  const orderedColumns = orderColumns(
    Array.from({ length: maxDepth + 1 }, (_, depth) => columns.get(depth) ?? []),
    edges,
    maxDepth
  );

  const positionsByKey = new Map<string, { x: number; y: number }>();
  const yPadding = 90;
  const xSpan = W - FRAME_PADDING_X * 2;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const column = orderedColumns[depth] ?? [];
    if (column.length === 0) {
      continue;
    }

    const progress = maxDepth === 0 ? 0.5 : depth / maxDepth;
    const x = maxDepth === 0 ? W / 2 : FRAME_PADDING_X + progress * xSpan;
    const centerY = H / 2;
    const spread = Math.min(H - yPadding * 2, Math.max(0, (column.length - 1) * 84));
    const startY = centerY - spread / 2;
    const step = column.length <= 1 ? 0 : spread / (column.length - 1);

    column.forEach((graphNode, index) => {
      const y = column.length === 1 ? centerY : startY + index * step;
      positionsByKey.set(graphNode.key, { x, y });
    });
  }

  return {
    nodes,
    edges,
    positions: nodes.map((graphNode) => positionsByKey.get(graphNode.key) ?? { x: W / 2, y: H / 2 })
  };
}

export default function ConstellationGraph({
  result,
  onNodeClick,
  onTopAnchorChange,
  wireSpeed = 1,
  nodeDrift = 1,
  isCompactLayout = false
}: ConstellationGraphProps) {
  const graph = useMemo(() => buildGraph(result), [result]);
  const svgRef = useRef<SVGSVGElement>(null);
  const nodeGroupRefs = useRef<(SVGGElement | null)[]>([]);
  const edgeGroupRefs = useRef<(SVGGElement | null)[]>([]);
  const pulseRefs = useRef<(SVGLineElement | null)[]>([]);
  const physicsRef = useRef<PhysicsNode[]>([]);
  const animFrameRef = useRef<number>(0);
  const dragRef = useRef<{
    nodeIndex: number;
    startMouseX: number;
    startMouseY: number;
    startNodeX: number;
    startNodeY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const reportedTopYRef = useRef<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const keyToIndex = useMemo(
    () => new Map(graph.nodes.map((graphNode, index) => [graphNode.key, index])),
    [graph.nodes]
  );

  const updateGraphDom = useCallback(
    (nodes: PhysicsNode[], pulseTime = 0) => {
      nodes.forEach((node, index) => {
        const group = nodeGroupRefs.current[index];
        if (group) {
          group.setAttribute('transform', `translate(${node.x.toFixed(2)},${node.y.toFixed(2)})`);
        }
      });

      if (onTopAnchorChange) {
        let minTopY = Number.POSITIVE_INFINITY;
        for (const node of nodes) {
          const anchorY = node.isDragging ? node.y : node.baseY;
          if (anchorY < minTopY) {
            minTopY = anchorY;
          }
        }
        if (
          Number.isFinite(minTopY) &&
          (reportedTopYRef.current === null || Math.abs(reportedTopYRef.current - minTopY) > 1)
        ) {
          reportedTopYRef.current = minTopY;
          onTopAnchorChange(minTopY);
        }
      }

      graph.edges.forEach((edge, index) => {
        const fromIndex = keyToIndex.get(edge.fromKey);
        const toIndex = keyToIndex.get(edge.toKey);
        if (fromIndex === undefined || toIndex === undefined) {
          return;
        }

        const from = nodes[fromIndex];
        const to = nodes[toIndex];
        if (!from || !to) {
          return;
        }

        const edgeGroup = edgeGroupRefs.current[index];
        if (edgeGroup) {
          const lines = edgeGroup.querySelectorAll('line');
          lines.forEach((line) => {
            line.setAttribute('x1', from.x.toFixed(2));
            line.setAttribute('y1', from.y.toFixed(2));
            line.setAttribute('x2', to.x.toFixed(2));
            line.setAttribute('y2', to.y.toFixed(2));
          });
        }

        const pulse = pulseRefs.current[index];
        if (!pulse || wireSpeed <= 0) {
          return;
        }

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        const dashLen = Math.max(26, len * 0.18);
        const speed = 38 * wireSpeed;
        const offset = -(((pulseTime * speed) % (len + dashLen)) - dashLen);

        pulse.setAttribute('x1', from.x.toFixed(2));
        pulse.setAttribute('y1', from.y.toFixed(2));
        pulse.setAttribute('x2', to.x.toFixed(2));
        pulse.setAttribute('y2', to.y.toFixed(2));
        pulse.setAttribute('stroke-dasharray', `${dashLen} ${len}`);
        pulse.setAttribute('stroke-dashoffset', offset.toFixed(2));
      });
    },
    [graph.edges, keyToIndex, onTopAnchorChange, wireSpeed]
  );

  useEffect(() => {
    const adjacency = graph.nodes.map(() => new Set<number>());
    for (const edge of graph.edges) {
      const fromIndex = keyToIndex.get(edge.fromKey);
      const toIndex = keyToIndex.get(edge.toKey);
      if (fromIndex === undefined || toIndex === undefined) {
        continue;
      }
      adjacency[fromIndex]!.add(toIndex);
      adjacency[toIndex]!.add(fromIndex);
    }

    physicsRef.current = graph.nodes.map((graphNode, index) => ({
      key: graphNode.key,
      baseX: graph.positions[index]?.x ?? W / 2,
      baseY: graph.positions[index]?.y ?? H / 2,
      x: graph.positions[index]?.x ?? W / 2,
      y: graph.positions[index]?.y ?? H / 2,
      vx: 0,
      vy: 0,
      floatPhaseX: Math.random() * Math.PI * 2,
      floatPhaseY: Math.random() * Math.PI * 2,
      floatFreqX: 0.35 + Math.random() * 0.25,
      floatFreqY: 0.28 + Math.random() * 0.2,
      isDragging: false,
      adjacentIndices: Array.from(adjacency[index]!),
      pullX: 0,
      pullY: 0,
      pullVX: 0,
      pullVY: 0
    }));
  }, [graph, keyToIndex]);

  useEffect(() => {
    let startTime = performance.now();
    let pulseTime = 0;
    let lastFrameTime = 0;
    const shouldAnimate = nodeDrift > 0 || wireSpeed > 0;
    const targetFrameMs = 1000 / 30;

    const tick = (now: number) => {
      if (shouldAnimate && now - lastFrameTime < targetFrameMs) {
        animFrameRef.current = requestAnimationFrame(tick);
        return;
      }
      lastFrameTime = now;

      const elapsed = (now - startTime) / 1000;
      pulseTime += targetFrameMs / 1000;
      const nodes = physicsRef.current;

      if (!nodes.length) {
        if (shouldAnimate) {
          animFrameRef.current = requestAnimationFrame(tick);
        }
        return;
      }

      nodes.forEach((node) => {
        const floatX = FLOAT_AMP * nodeDrift * Math.sin(elapsed * node.floatFreqX + node.floatPhaseX);
        const floatY = FLOAT_AMP * nodeDrift * Math.sin(elapsed * node.floatFreqY + node.floatPhaseY);
        const targetX = node.baseX + floatX + node.pullX;
        const targetY = node.baseY + floatY + node.pullY;

        if (node.isDragging) {
          node.pullVX *= SPRING_D;
          node.pullVY *= SPRING_D;
          node.pullX += node.pullVX;
          node.pullY += node.pullVY;
        } else {
          node.vx = node.vx * SPRING_D + (targetX - node.x) * SPRING_K;
          node.vy = node.vy * SPRING_D + (targetY - node.y) * SPRING_K;
          node.x += node.vx;
          node.y += node.vy;
          node.pullVX = node.pullVX * 0.9 + (0 - node.pullX) * 0.04;
          node.pullVY = node.pullVY * 0.9 + (0 - node.pullY) * 0.04;
          node.pullX += node.pullVX;
          node.pullY += node.pullVY;
        }
      });

      updateGraphDom(nodes, pulseTime);

      if (shouldAnimate) {
        animFrameRef.current = requestAnimationFrame(tick);
      }
    };

    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [nodeDrift, updateGraphDom, wireSpeed]);

  const getSvgPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) {
      return { x: 0, y: 0 };
    }
    const rect = svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * W,
      y: ((clientY - rect.top) / rect.height) * H
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent, nodeIndex: number) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const point = getSvgPoint(event.clientX, event.clientY);
      const node = physicsRef.current[nodeIndex];
      if (!node) {
        return;
      }

      node.isDragging = true;
      dragRef.current = {
        nodeIndex,
        startMouseX: point.x,
        startMouseY: point.y,
        startNodeX: node.x,
        startNodeY: node.y,
        moved: false
      };
      (event.target as Element).setPointerCapture(event.pointerId);
    },
    [getSvgPoint]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragRef.current) {
        return;
      }

      const point = getSvgPoint(event.clientX, event.clientY);
      const { nodeIndex, startMouseX, startMouseY, startNodeX, startNodeY } = dragRef.current;
      const node = physicsRef.current[nodeIndex];
      if (!node) {
        return;
      }

      const dx = point.x - startMouseX;
      const dy = point.y - startMouseY;
      if (Math.hypot(dx, dy) > DRAG_CLICK_THRESHOLD) {
        dragRef.current.moved = true;
      }
      node.x = startNodeX + dx;
      node.y = startNodeY + dy;
      updateGraphDom(physicsRef.current);
    },
    [getSvgPoint, updateGraphDom]
  );

  const handlePointerUp = useCallback(() => {
    if (!dragRef.current) {
      return;
    }
    const node = physicsRef.current[dragRef.current.nodeIndex];
    if (node) {
      node.isDragging = false;
      node.baseX = node.x;
      node.baseY = node.y;
      node.vx = 0;
      node.vy = 0;
      node.pullX = 0;
      node.pullY = 0;
      node.pullVX = 0;
      node.pullVY = 0;
      if (dragRef.current.moved) {
        suppressClickRef.current = node.key;
      }
    }
    dragRef.current = null;
    updateGraphDom(physicsRef.current);
  }, [updateGraphDom]);

  const nodeLayouts = graph.nodes.map((graphNode) => {
    const maxTextWidth = graphNode.node.isStart || graphNode.node.isEnd
      ? MAX_SPECIAL_NODE_TEXT_WIDTH
      : MAX_NODE_TEXT_WIDTH;
    const lines = wrapNodeTitle(graphNode.node.displayTitle, maxTextWidth);
    const widestLine = Math.max(...lines.map((line) => estimateTextWidth(line)), 0);
    const lineHeight = graphNode.node.isStart || graphNode.node.isEnd ? 15 : 14;
    return {
      lines,
      w: Math.min(maxTextWidth, widestLine) + 18,
      h: Math.max(26, lines.length * lineHeight + 14),
      lineHeight
    };
  });

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: '100%', height: '100%', overflow: 'visible' }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      {graph.edges.map((edge, index) => {
        const fromIndex = keyToIndex.get(edge.fromKey);
        const toIndex = keyToIndex.get(edge.toKey);
        const from = fromIndex === undefined ? null : graph.nodes[fromIndex];
        const to = toIndex === undefined ? null : graph.nodes[toIndex];
        const fromPosition = fromIndex === undefined ? null : graph.positions[fromIndex];
        const toPosition = toIndex === undefined ? null : graph.positions[toIndex];
        if (!from || !to || !fromPosition || !toPosition) {
          return null;
        }

        const isHovered =
          hoveredIndex !== null && (hoveredIndex === fromIndex || hoveredIndex === toIndex);
        const routeShare = edge.routeHits / Math.max(1, result.displayedRoutes || graph.edges.length);
        const glowOpacity = isHovered ? 0.55 : 0.16 + routeShare * 0.3;
        const crispOpacity = isHovered ? 0.72 : 0.2 + routeShare * 0.34;
        const width = isHovered ? 2.8 : 1 + routeShare * 1.8;

        return (
          <g
            key={edge.key}
            ref={(element) => {
              edgeGroupRefs.current[index] = element;
            }}
          >
            <line
              x1={fromPosition.x}
              y1={fromPosition.y}
              x2={toPosition.x}
              y2={toPosition.y}
              stroke={`rgba(200,205,230,${glowOpacity})`}
              strokeWidth={width + 1}
              style={{ transition: 'stroke 0.2s, stroke-width 0.2s' }}
            />
            <line
              x1={fromPosition.x}
              y1={fromPosition.y}
              x2={toPosition.x}
              y2={toPosition.y}
              stroke={`rgba(224,228,248,${crispOpacity})`}
              strokeWidth={width}
              style={{ transition: 'stroke 0.2s, stroke-width 0.2s' }}
            />
          </g>
        );
      })}

      {wireSpeed > 0 &&
        graph.edges.map((edge, index) => {
          const fromIndex = keyToIndex.get(edge.fromKey);
          const toIndex = keyToIndex.get(edge.toKey);
          const from = fromIndex === undefined ? null : graph.positions[fromIndex];
          const to = toIndex === undefined ? null : graph.positions[toIndex];
          if (!from || !to) {
            return null;
          }

          const routeShare = edge.routeHits / Math.max(1, result.displayedRoutes || graph.edges.length);
          return (
            <line
              key={`pulse-${edge.key}`}
              ref={(element) => {
                pulseRefs.current[index] = element;
              }}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={`rgba(240,242,255,${0.18 + routeShare * 0.28})`}
              strokeWidth={1.2 + routeShare}
              strokeLinecap="round"
            />
          );
        })}

      {graph.nodes.map((graphNode, index) => {
        const layout = nodeLayouts[index]!;
        const position = graph.positions[index] ?? { x: W / 2, y: H / 2 };
        const isSpecial = graphNode.node.isStart || graphNode.node.isEnd;
        const isHovered = hoveredIndex === index;
        const isAdjacentToHovered =
          hoveredIndex !== null &&
          graph.edges.some((edge) => {
            const fromIndex = keyToIndex.get(edge.fromKey);
            const toIndex = keyToIndex.get(edge.toKey);
            return (
              (fromIndex === hoveredIndex && toIndex === index) ||
              (toIndex === hoveredIndex && fromIndex === index)
            );
          });

        const nodeOpacity = isHovered ? 1 : isAdjacentToHovered ? 0.88 : 0.72;
        const borderOpacity = isHovered ? 0.95 : isSpecial ? 0.72 : 0.28 + (graphNode.routeHits / 5) * 0.24;
        const scaleFactor = isSpecial ? 1.08 : 1;
        const compactNodeScale = isCompactLayout ? 1.55 : 1;
        const width = layout.w * scaleFactor * compactNodeScale;
        const height = layout.h * (isSpecial ? 1.12 : 1) * compactNodeScale;
        const fontSize = (isSpecial ? 13.5 : 12) * compactNodeScale;
        const lineHeight = layout.lineHeight * compactNodeScale;
        const smallLabelSize = 8 * compactNodeScale;

        return (
          <g
            key={graphNode.key}
            ref={(element) => {
              nodeGroupRefs.current[index] = element;
            }}
            transform={`translate(${position.x},${position.y})`}
            style={{ cursor: 'grab', userSelect: 'none' }}
            onPointerDown={(event) => handlePointerDown(event, index)}
            onPointerEnter={() => setHoveredIndex(index)}
            onPointerLeave={() => setHoveredIndex(null)}
            onClick={() => {
              if (suppressClickRef.current === graphNode.key) {
                suppressClickRef.current = null;
                return;
              }
              onNodeClick?.(graphNode.node);
            }}
          >
            {isSpecial && (
              <rect
                x={-width / 2}
                y={-height / 2}
                width={width}
                height={height}
                rx={3}
                fill="rgba(240,242,255,0.06)"
              />
            )}
            {isHovered && (
              <rect
                x={-width / 2 - 4}
                y={-height / 2 - 4}
                width={width + 8}
                height={height + 8}
                rx={4}
                fill="rgba(220,225,255,0.04)"
              />
            )}
            <rect
              x={-width / 2}
              y={-height / 2}
              width={width}
              height={height}
              rx={2.5}
              fill={`rgba(8,9,16,${isSpecial ? 0.94 : 0.82})`}
            />
            <rect
              x={-width / 2}
              y={-height / 2}
              width={width}
              height={height}
              rx={2.5}
              fill="none"
              stroke={`rgba(215,220,255,${borderOpacity})`}
              strokeWidth={isSpecial ? 1 : 0.75}
            />
            {!isSpecial && (
              <text
                x={-width / 2 + 4}
                y={-height / 2 - 4}
                fill="rgba(160,165,200,0.45)"
                fontSize={smallLabelSize}
                fontFamily="var(--font-azeret), monospace"
                letterSpacing="0.5"
              >
                {String(graphNode.depth + 1).padStart(2, '0')}
              </text>
            )}
            {isSpecial && (
              <text
                x={0}
                y={-height / 2 - 5}
                fill="rgba(200,205,240,0.68)"
                fontSize={smallLabelSize}
                fontFamily="var(--font-azeret), monospace"
                textAnchor="middle"
                letterSpacing="1.5"
              >
                {graphNode.node.isStart ? 'START' : 'END'}
              </text>
            )}
            {graphNode.routeHits > 1 && !isSpecial && (
              <text
                x={width / 2 - 4}
                y={-height / 2 - 4}
                fill="rgba(180,185,220,0.55)"
                fontSize={smallLabelSize}
                fontFamily="var(--font-azeret), monospace"
                textAnchor="end"
                letterSpacing="0.5"
              >
                x{graphNode.routeHits}
              </text>
            )}
            <text
              x={0}
              y={0}
              fill={`rgba(228,230,248,${nodeOpacity})`}
              fontSize={fontSize}
              fontFamily="var(--font-syne), sans-serif"
              fontWeight={isSpecial ? '600' : '400'}
              textAnchor="middle"
              letterSpacing={isSpecial ? '0.3' : '0.1'}
              dominantBaseline="middle"
            >
              {layout.lines.map((line, lineIndex) => {
                const offset =
                  (lineIndex - (layout.lines.length - 1) / 2) * lineHeight;
                return (
                  <tspan key={`${graphNode.key}-${lineIndex}`} x={0} dy={lineIndex === 0 ? offset : lineHeight}>
                    {line}
                  </tspan>
                );
              })}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
