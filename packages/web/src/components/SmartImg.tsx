import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

/**
 * #fix: <img> 兜底组件 — 修复聊天/文档里两类图片加载失败：
 *
 * 1. 旧版 generate_image 坏链 `/api/v1/files/<id>/download`（该形状在主
 *    服务器上不存在且无 chart token，404/401）— 渲染期经 Bearer 鉴权的
 *    download-url 端点归一化为 canonical token URL。
 * 2. token 过期的 canonical URL（90 天 TTL）— onError 时重新签发一次，
 *    自愈后仍失败才隐藏，避免陈旧消息里的图永久丢失。
 *
 * 非 /api/v1/files 的 src（外链、data:) 原样透传。
 */

/** 旧版坏链形状：/files/<id>/download — 排除 canonical download/、preview-page/ 前缀。 */
const LEGACY_FILE_URL = /^\/api\/v1\/files\/(?!download\/|preview-page\/)([^/?#]+)\/download$/;
/** canonical 形状：/files/download/<id>（token 可有可无）。 */
const CANONICAL_FILE_URL = /^\/api\/v1\/files\/download\/([^/?#]+)/;

/** fileId → tokenized URL 的进程内缓存（含 in-flight 去重）。 */
const mintCache = new Map<string, Promise<string | null>>();

function legacyFileId(src: string): string | null {
  const m = LEGACY_FILE_URL.exec(src);
  return m ? decodeURIComponent(m[1]) : null;
}

function canonicalFileId(src: string): string | null {
  const m = CANONICAL_FILE_URL.exec(src);
  return m ? decodeURIComponent(m[1]) : null;
}

function mintDownloadUrl(fileId: string, refresh = false): Promise<string | null> {
  const cached = mintCache.get(fileId);
  if (cached && !refresh) return cached;
  const p = api
    .getDownloadUrl(fileId)
    .then((r) => r.url)
    .catch(() => null);
  mintCache.set(fileId, p);
  return p;
}

interface Props {
  src?: string;
  alt?: string;
  className?: string;
}

export function SmartImg({ src, alt, className }: Props) {
  const [url, setUrl] = useState<string | undefined>(() => (src && !legacyFileId(src) ? src : undefined));
  const [failed, setFailed] = useState(false);
  const healedRef = useRef(false);

  useEffect(() => {
    setFailed(false);
    healedRef.current = false;
    const legacy = src ? legacyFileId(src) : null;
    if (!legacy) {
      setUrl(src);
      return;
    }
    let alive = true;
    mintDownloadUrl(legacy).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [src]);

  if (failed || !url) return null;

  return (
    <img
      src={url}
      alt={alt || ''}
      className={className}
      onError={() => {
        const fileId = canonicalFileId(url);
        // 只自愈一次 — 二次失败（文件确实不存在等）直接隐藏，避免循环。
        if (fileId && !healedRef.current) {
          healedRef.current = true;
          mintDownloadUrl(fileId, true).then((u) => {
            if (u) setUrl(u);
            else setFailed(true);
          });
          return;
        }
        setFailed(true);
      }}
    />
  );
}
