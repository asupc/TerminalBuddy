import { useMemo, useState } from "react";
import type { AiDeliveryEvent } from "../../types/aiDelivery";
import { eventTypeName, isFailedEventType, formatEventTime } from "./workspace-utils";

interface EventListViewProps {
  events: AiDeliveryEvent[];
  pageSize?: number;
}

/**
 * 通用事件列表：最新在前、关键字搜索、分页展示。
 * 输入按 occurredAt 升序（get_delivery_events 返回序），组件内部 reverse 以匹配既有时间线 UX。
 */
export function EventListView({ events, pageSize = 100 }: EventListViewProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter((event) =>
      event.eventType.toLowerCase().includes(q)
      || (event.message ?? "").toLowerCase().includes(q),
    );
  }, [events, query]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageEvents = useMemo(
    () => filtered.slice(-(page + 1) * pageSize, filtered.length - page * pageSize).reverse(),
    [filtered, page, pageSize],
  );

  return (
    <div className="ai-event-list-view">
      <div className="ai-event-list-toolbar">
        <input
          type="search"
          placeholder="搜索事件（类型或内容）..."
          value={query}
          onChange={(event) => { setQuery(event.target.value); setPage(0); }}
        />
        <span>共 {filtered.length} 条</span>
      </div>
      {pageEvents.length === 0 ? (
        <p className="ai-delivery-events-empty">没有匹配的事件。</p>
      ) : (
        <ol>
          {pageEvents.map((event) => (
            <li key={event.id} className={isFailedEventType(event.eventType) ? "ai-event-failed" : undefined}>
              <time dateTime={event.occurredAt}>
                {formatEventTime(event.occurredAt)}
              </time>
              <div>
                <strong>{eventTypeName(event.eventType)}</strong>
                <p>{event.message}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="ai-event-list-pager">
        <button
          type="button"
          className="btn-secondary"
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
        >
          上一页
        </button>
        <span>{page + 1}/{pages}</span>
        <button
          type="button"
          className="btn-secondary"
          disabled={page >= pages - 1}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
