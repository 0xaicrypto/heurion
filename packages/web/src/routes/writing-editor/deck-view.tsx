import { useTranslation } from 'react-i18next';
import { FilePlus, Pencil, Presentation, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui';
import type { Slide } from '@/lib/deck';
import type { DeckWire } from '@/lib/types';
import type { DeckAsset } from './deck-asset';

/** #688: deck 卡片网格视图 — 从 writing-editor 路由机械拆出；
 * deck 数据与操作状态仍归路由，单卡片操作回调经 props 传入。 */
export function DeckView(input: {
  deckAsset: DeckWire | null;
  slides: Slide[];
  body: string;
  deckCtl: DeckAsset;
  sendChatText: (text: string) => Promise<void>;
  onCardEdit: (slide: Slide) => void;
}) {
  const { t } = useTranslation();
  const { deckAsset, slides, body, deckCtl, sendChatText, onCardEdit } = input;
  return (
    <div className="space-y-3">
                    {deckAsset ? (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2">
                        <span className="text-xs text-accent">
                          {t('writing.deckAssetBadge', 'AI 编排 deck 资产 — 卡片内可直接编辑（改标题/调要点/删页），保存不会改动文档正文。')}
                        </span>
                        <div className="flex shrink-0 items-center gap-2">
                          {/* #959: deck 级主题选择（contracts v2）— 预览与导出（worker 母版）同语义。 */}
                          <select
                            value={deckAsset.theme ?? ''}
                            onChange={(e) => deckCtl.setDeckTheme(e.target.value || undefined)}
                            title={t('writing.deckTheme', 'deck 主题（导出 PPT 应用主题母版）')}
                            className="rounded border border-border bg-surface px-1.5 py-1 text-[11px] text-text-secondary outline-none focus:ring-1 focus:ring-ring"
                          >
                            <option value="">{t('writing.deckThemeDefault', '主题：默认')}</option>
                            <option value="clinical">{t('writing.deckThemeClinical', '临床蓝')}</option>
                            <option value="warm-paper">{t('writing.deckThemeWarmPaper', '暖色纸面')}</option>
                          </select>
                          <Button size="sm" variant="secondary" onClick={deckCtl.addDeckSlide}>
                            <FilePlus size={13} className="mr-1" /> {t('writing.deckAddSlide', '添加一页')}
                          </Button>
                        </div>
                      </div>
                    ) : slides.length <= 1 && body.trim() && (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-surface-elevated px-4 py-2.5">
                        <span className="text-xs text-text-secondary">
                          {t('writing.deckSinglePageHint', '文档还没有 ## 分页结构，导出 PPT 只会有一页。可让 AI 按内容语义拆页。')}
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void sendChatText(t('writing.aiSplitPrompt', '请把当前稿件按内容语义拆成多页（每页一个 ## 二级标题），为生成 PPT 做准备。'))}
                        >
                          <Sparkles size={13} className="mr-1" /> {t('writing.aiSplitPages', 'AI 帮我拆页')}
                        </Button>
                      </div>
                    )}
                    {deckAsset ? (
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        {deckAsset.slides.map((slide, i) => (
                          <div
                            key={i}
                            draggable
                            onDragStart={(e) => { e.dataTransfer.setData('text/deck-index', String(i)); e.dataTransfer.effectAllowed = 'move'; }}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const from = Number(e.dataTransfer.getData('text/deck-index'));
                              if (Number.isInteger(from) && from !== i) deckCtl.moveDeckSlide(from, i);
                            }}
                            title={t('writing.deckDragHint', '拖拽卡片可调整页序')}
                            className="flex aspect-video flex-col overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-sm transition-shadow hover:shadow-md"
                          >
                            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                              <span className="shrink-0 text-[11px] font-semibold text-text-tertiary">{i + 1}.</span>
                              <input
                                value={slide.title}
                                onChange={(e) => deckCtl.updateDeckSlide(i, { title: e.target.value })}
                                className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-xs font-semibold text-text-primary outline-none focus:bg-surface focus:ring-1 focus:ring-ring"
                              />
                              {/* #959: 每页布局母版选择（contracts v2）— 预览/导出同语义。 */}
                              <select
                                value={slide.layout ?? ''}
                                onChange={(e) => deckCtl.setDeckSlideLayout(i, e.target.value || undefined)}
                                title={t('writing.deckLayout', '布局母版')}
                                className="shrink-0 rounded border border-border bg-surface px-1 py-0.5 text-[10px] text-text-secondary outline-none focus:ring-1 focus:ring-ring"
                              >
                                <option value="">{t('writing.deckLayoutDefault', '默认')}</option>
                                <option value="title">{t('writing.deckLayoutTitle', '封面')}</option>
                                <option value="section">{t('writing.deckLayoutSection', '章节页')}</option>
                                <option value="bullets">{t('writing.deckLayoutBullets', '要点')}</option>
                                <option value="bullets+image">{t('writing.deckLayoutBulletsImage', '要点+图')}</option>
                                <option value="chart-full">{t('writing.deckLayoutChartFull', '整页图表')}</option>
                                <option value="quote">{t('writing.deckLayoutQuote', '引用')}</option>
                                <option value="blank">{t('writing.deckLayoutBlank', '空白')}</option>
                              </select>
                              <button
                                onClick={() => deckCtl.deleteDeckSlide(i)}
                                title={t('writing.deckDeleteSlide', '删除此页')}
                                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-error"
                              >
                                <X size={12} />
                              </button>
                            </div>
                            <div className="flex flex-1 flex-col gap-1 overflow-hidden px-3 py-2 text-xs leading-relaxed text-text-secondary">
                              {deckCtl.slideBullets(slide).map((b, j) => (
                                <div key={j} className="flex min-w-0 items-start gap-1.5">
                                  <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
                                  <input
                                    value={b}
                                    onChange={(e) => {
                                      const bullets = deckCtl.slideBullets(slide).map((x, k) => (k === j ? e.target.value : x));
                                      deckCtl.updateDeckSlide(i, { bullets });
                                    }}
                                    className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 outline-none focus:bg-surface focus:ring-1 focus:ring-ring"
                                  />
                                </div>
                              ))}
                              <button
                                onClick={() => deckCtl.updateDeckSlide(i, { bullets: [...deckCtl.slideBullets(slide), ''] })}
                                className="self-start rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-accent"
                              >
                                + {t('writing.deckAddBullet', '要点')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      {slides.map((slide, i) => (
                        <div
                          key={i}
                          className="group relative flex aspect-video flex-col overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-sm transition-shadow hover:shadow-md"
                        >
                          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
                            <span className="truncate text-xs font-semibold text-text-primary">
                              {i + 1}. {slide.title}
                            </span>
                            <button
                              onClick={() => onCardEdit(slide)}
                              title={t('writing.deckCardEdit', '跳回文档编辑此页')}
                              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary transition-opacity hover:bg-surface hover:text-accent group-hover:opacity-100 md:opacity-0"
                            >
                              <Pencil size={11} /> {t('writing.deckCardEdit', '编辑')}
                            </button>
                          </div>
                          <div className="flex flex-1 flex-col gap-1.5 overflow-hidden px-3 py-2 text-xs leading-relaxed text-text-secondary">
                            {slide.blocks.slice(0, 8).map((b, j) =>
                              b.type === 'image' ? (
                                <img key={j} src={b.url} alt={b.caption || ''} className="max-h-[55%] w-auto self-start rounded border border-border object-contain" />
                              ) : b.type === 'bullet' ? (
                                <div key={j} className="flex min-w-0 items-start gap-1.5">
                                  <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
                                  <span className="line-clamp-2">{b.text}</span>
                                </div>
                              ) : (
                                <p key={j} className="line-clamp-2">{b.text}</p>
                              ),
                            )}
                            {slide.blocks.length > 8 && (
                              <span className="text-[11px] text-text-tertiary">…{t('writing.deckMoreBlocks', '还有 {{n}} 段', { n: slide.blocks.length - 8 })}</span>
                            )}
                          </div>
                        </div>
                      ))}
                      </div>
                    )}
                    {/* #770 设计更新 2：导出交互 = 预填 chat 消息发送，不新建旁路 API。
                        #773: deck 资产存在时导出内容源 = Doc.deck（所见即所导）。 */}
                    <div className="flex justify-end">
                      <Button size="sm" onClick={() => void sendChatText(deckAsset
                        ? t('writing.aiExportDeckPrompt', '请把当前 deck 导出为 PPT（使用现有 deck 内容，不要重新编排）。')
                        : t('writing.aiExportPptPrompt', '请把当前稿件导出为 PPT。'))}>
                        <Presentation size={13} className="mr-1" /> {t('writing.aiExportPpt', 'AI 导出 PPT')}
                      </Button>
                    </div>
    </div>
  );
}
