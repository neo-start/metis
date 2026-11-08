import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { EraserIcon, PencilIcon, Redo2Icon, Trash2, Undo2Icon } from "~/lib/icons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

const WIDTH = 1200;
const HEIGHT = 800;
type Tool = "pen" | "eraser" | "rectangle" | "ellipse" | "arrow" | "text";
type Point = { x: number; y: number };
type Mark = { tool: Tool; points: Point[]; color: string; width: number; text: string };
const TOOLS: { tool: Tool; label: string }[] = [
  { tool: "pen", label: "画笔" },
  { tool: "eraser", label: "橡皮擦" },
  { tool: "rectangle", label: "矩形" },
  { tool: "ellipse", label: "椭圆" },
  { tool: "arrow", label: "箭头" },
  { tool: "text", label: "文字" },
];

// Fixed document coordinates keep strokes and exported PNGs identical at every viewport size.
function paint(canvas: HTMLCanvasElement, marks: readonly Mark[], active?: Mark | null) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  for (const mark of active ? [...marks, active] : marks) {
    const start = mark.points[0];
    const end = mark.points.at(-1);
    if (!start || !end) continue;
    ctx.strokeStyle = mark.tool === "eraser" ? "#ffffff" : mark.color;
    ctx.fillStyle = mark.color;
    ctx.lineWidth = mark.tool === "eraser" ? mark.width * 6 : mark.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (mark.tool === "text") {
      ctx.font = `${18 + mark.width * 2}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(mark.text, start.x, start.y);
    } else if (mark.tool === "rectangle") {
      ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
    } else if (mark.tool === "ellipse") {
      ctx.ellipse(
        (start.x + end.x) / 2,
        (start.y + end.y) / 2,
        Math.abs(end.x - start.x) / 2,
        Math.abs(end.y - start.y) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    } else {
      ctx.moveTo(start.x, start.y);
      for (const point of mark.points.slice(1)) ctx.lineTo(point.x, point.y);
      if (mark.points.length === 1) ctx.lineTo(start.x + 0.01, start.y);
      if (mark.tool === "arrow") {
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const head = 14 + mark.width * 2;
        for (const offset of [-Math.PI / 6, Math.PI / 6]) {
          ctx.moveTo(end.x, end.y);
          ctx.lineTo(
            end.x - head * Math.cos(angle + offset),
            end.y - head * Math.sin(angle + offset),
          );
        }
      }
      ctx.stroke();
    }
  }
}

export function ComposerDrawingBoard({
  open,
  onOpenChange,
  onAttach,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAttach: (file: File) => boolean;
  disabled: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const active = useRef<Mark | null>(null);
  const pointer = useRef<number | null>(null);
  const mounted = useRef(true);
  const attachRef = useRef(onAttach);
  useLayoutEffect(() => {
    attachRef.current = onAttach;
  }, [onAttach]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [redo, setRedo] = useState<Mark[][]>([]);
  const [undo, setUndo] = useState<Mark[][]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#1e293b");
  const [width, setWidth] = useState(3);
  const [label, setLabel] = useState("");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) {
      active.current = null;
      pointer.current = null;
    }
  }, [open]);
  const redraw = (next: Mark[] = marks) => {
    if (canvasRef.current) paint(canvasRef.current, next, active.current);
  };
  const commit = (next: Mark[]) => {
    setUndo((history) => [...history.slice(-49), marks]);
    setRedo([]);
    setMarks(next);
    redraw(next);
  };
  const point = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(WIDTH, ((event.clientX - rect.left) * WIDTH) / rect.width)),
      y: Math.max(0, Math.min(HEIGHT, ((event.clientY - rect.top) * HEIGHT) / rect.height)),
    };
  };
  const finish = (event: PointerEvent<HTMLCanvasElement>, cancel = false) => {
    if (pointer.current !== event.pointerId) return;
    const mark = active.current;
    if (mark && !cancel) {
      const end = point(event);
      mark.points =
        mark.tool === "pen" || mark.tool === "eraser"
          ? [...mark.points, end]
          : [mark.points[0]!, end];
    }
    active.current = null;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (mark && !cancel) commit([...marks, mark]);
    else redraw();
  };
  const exportImage = () => {
    if (!canvasRef.current || exporting || disabled) return;
    setExporting(true);
    setError(null);
    paint(canvasRef.current, marks);
    canvasRef.current.toBlob((blob) => {
      if (!mounted.current) return;
      setExporting(false);
      if (!blob) {
        setError("图片生成失败，请重试。");
        return;
      }
      if (
        attachRef.current(new File([blob], `ui-sketch-${Date.now()}.png`, { type: "image/png" }))
      ) {
        onOpenChange(false);
      } else {
        setError("暂时无法添加图片，请检查附件数量或会话状态后重试。");
      }
    }, "image/png");
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!exporting) onOpenChange(next);
      }}
    >
      <DialogPopup className="w-[min(960px,96vw)] max-w-none" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>画板</DialogTitle>
          <DialogDescription>
            画出你想要的 UI，再添加到会话。关闭后可继续编辑，切换会话或刷新会清除画板。
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex flex-wrap items-center gap-1 border-b px-4 py-2"
          role="toolbar"
          aria-label="画板工具"
        >
          {TOOLS.map((item) => (
            <Button
              key={item.tool}
              type="button"
              size="sm"
              variant={tool === item.tool ? "secondary" : "ghost"}
              aria-pressed={tool === item.tool}
              onClick={() => setTool(item.tool)}
              disabled={exporting}
            >
              {item.tool === "pen" ? (
                <PencilIcon className="size-4" />
              ) : item.tool === "eraser" ? (
                <EraserIcon className="size-4" />
              ) : null}
              {item.label}
            </Button>
          ))}
          <label className="ml-2 flex items-center gap-2 text-ui-sm">
            颜色
            <input
              type="color"
              aria-label="画笔颜色"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="size-7 cursor-pointer"
            />
          </label>
          <label className="ml-2 flex items-center gap-2 text-ui-sm">
            粗细
            <input
              type="range"
              aria-label="画笔粗细"
              min="1"
              max="12"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              className="w-20 accent-primary"
            />
          </label>
          <div className="ml-auto flex gap-1">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="撤销"
              aria-label="撤销"
              disabled={!undo.length || exporting}
              onClick={() => {
                const previous = undo.at(-1)!;
                setRedo((history) => [...history, marks]);
                setUndo(undo.slice(0, -1));
                setMarks(previous);
                redraw(previous);
              }}
            >
              <Undo2Icon className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="重做"
              aria-label="重做"
              disabled={!redo.length || exporting}
              onClick={() => {
                const next = redo.at(-1)!;
                setUndo((history) => [...history, marks]);
                setRedo(redo.slice(0, -1));
                setMarks(next);
                redraw(next);
              }}
            >
              <Redo2Icon className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="清空（可撤销）"
              aria-label="清空画板"
              disabled={!marks.length || exporting}
              onClick={() => commit([])}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
        {tool === "text" ? (
          <div className="px-4 pt-2">
            <Input
              aria-label="要添加的文字"
              placeholder="输入文字，然后点击画布放置"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={200}
            />
          </div>
        ) : null}
        <div className="min-h-0 overflow-auto bg-muted/30 p-4">
          <canvas
            ref={(canvas) => {
              canvasRef.current = canvas;
              if (canvas) paint(canvas, marks, active.current);
            }}
            width={WIDTH}
            height={HEIGHT}
            aria-label="UI 草图画布，使用指针绘制"
            role="img"
            className="mx-auto block h-auto aspect-[3/2] max-h-[55dvh] w-full touch-none rounded-sm bg-white shadow-sm"
            style={{
              cursor: tool === "text" ? "text" : "crosshair",
              objectFit: "contain",
              width: "min(100%, 82.5dvh)",
            }}
            onPointerDown={(event) => {
              if (exporting || pointer.current !== null || event.button !== 0) return;
              event.preventDefault();
              const mark: Mark = { tool, color, width, text: label.trim(), points: [point(event)] };
              if (tool === "text") {
                if (mark.text) commit([...marks, mark]);
                return;
              }
              pointer.current = event.pointerId;
              active.current = mark;
              event.currentTarget.setPointerCapture(event.pointerId);
              redraw();
            }}
            onPointerMove={(event) => {
              if (pointer.current !== event.pointerId || !active.current) return;
              const mark = active.current;
              mark.points =
                mark.tool === "pen" || mark.tool === "eraser"
                  ? [...mark.points, point(event)]
                  : [mark.points[0]!, point(event)];
              redraw();
            }}
            onPointerUp={(event) => finish(event)}
            onPointerCancel={(event) => finish(event, true)}
            onLostPointerCapture={(event) => finish(event, true)}
          />
        </div>
        {error ? (
          <p className="px-4 text-ui-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={exporting}
            onClick={() => onOpenChange(false)}
          >
            暂时关闭
          </Button>
          <Button
            type="button"
            disabled={!marks.length || exporting || disabled}
            onClick={exportImage}
          >
            {exporting ? "正在生成图片…" : "添加到会话"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
