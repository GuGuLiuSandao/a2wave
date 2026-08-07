import { Button } from '@/components/ui/button'
import { useOnboarding } from '@/hooks/use-onboarding'
import { Modal } from 'antd'
import { PartyPopper, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ACTIONS, EVENTS, Joyride, type Step, type TooltipRenderProps } from 'react-joyride'
import { useLocation } from 'react-router-dom'

/** 自定义气泡：对齐原有风格（左对齐标题 + 灰正文 + 右上角关闭 + 左下角 N/7 进度）。 */
function OnboardingTooltip({ step, index, size, closeProps, tooltipProps }: TooltipRenderProps) {
  return (
    <div
      {...tooltipProps}
      className="relative w-[340px] max-w-[88vw] rounded-xl bg-card p-4 text-left shadow-xl ring-1 ring-black/5"
    >
      <button
        type="button"
        {...closeProps}
        className="absolute right-3 top-3 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      {step.title && <div className="pr-6 text-sm font-semibold text-foreground">{step.title}</div>}
      <div className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{step.content}</div>
      <div className="mt-3 text-xs text-muted-foreground/80">
        {index + 1} / {size}
      </div>
    </div>
  )
}

/**
 * 新手引导（FTUE）总编排器 —— 单一实例，挂在 Layout 根部，跨路由不卸载。
 *
 * 设计要点（取代之前按页拼接 antd Tour 的脆弱实现）：
 * - 单一事实源：是否进行中 = useOnboarding().active（localStorage），完成态在后端。
 * - 步骤「由应用状态推导」：当前显示哪一步是 (路由 + DOM) 的纯函数，不靠命令式 stepIndex 推进、
 *   不需要 handoff/defer/轮询缝合。用户做真实动作（点按钮/开弹窗/填 key/跳转）→ 状态变化 →
 *   推导出的步骤自然跟进。react-joyride 受控 stepIndex + 原生「等目标出现」（targetWaitTimeout）。
 * - 业务组件只保留 data-tour 锚点，无任何引导逻辑。
 */

// 步骤顺序固定；stepIndex 指向其中一项。共 10 步。
const STEP_IDS = [
  'nav-agents',
  'new-agent',
  'pick-template',
  'fill-key',
  'create',
  'enable-feishu',
  'choose-method',
  'enter-app-id',
  'enter-app-secret',
  'publish',
] as const
type StepId = (typeof STEP_IDS)[number]

// 各步目标选择器（用于稳定性门控：等目标位置稳定后再显示，避免弹窗动画期的位移跳动）。
const STEP_TARGET: Record<StepId, string> = {
  'nav-agents': '[data-tour="nav-agents"]',
  'new-agent': '[data-tour="new-agent-btn"]',
  'pick-template': '[data-tour="tpl-newbie"]',
  'fill-key': '[data-testid="provider-chain-api-key-0"]',
  create: '[data-tour="agent-submit"]',
  'enable-feishu': '[data-tour="feishu-enable"]',
  'choose-method': '[data-tour="feishu-setup"]',
  'enter-app-id': '[data-tour="feishu-app-id"]',
  'enter-app-secret': '[data-tour="feishu-app-secret"]',
  publish: '[data-tour="publish-btn"]',
}

function elVisible(selector: string): boolean {
  const el = document.querySelector(selector)
  return !!(el && (el as HTMLElement).getBoundingClientRect().width > 0)
}

function inputValue(selector: string): string {
  return (
    (document.querySelector(`${selector} input`) as HTMLInputElement | null)?.value?.trim() ?? ''
  )
}

/** 当前应处于哪一步：路由 + DOM 的纯函数。返回 null 表示当前页无引导步骤。 */
function deriveStepId(pathname: string, search: string): StepId | null {
  const params = new URLSearchParams(search)
  if (pathname === '/') return 'nav-agents'
  if (pathname === '/agents') {
    return elVisible('[data-tour="tpl-newbie"]') ? 'pick-template' : 'new-agent'
  }
  if (pathname === '/agents/new') {
    const key = (
      document.querySelector('[data-testid="provider-chain-api-key-0"]') as HTMLInputElement | null
    )?.value
    return key?.trim() ? 'create' : 'fill-key'
  }
  // 已创建的 Agent 详情 + 发布页 + 飞书子页
  if (
    /^\/agents\/agt_/.test(pathname) &&
    params.get('tab') === 'publish' &&
    params.get('publishTab') === 'feishu'
  ) {
    if (elVisible('[data-tour="feishu-setup"]')) return 'choose-method'
    const switchOn = !!document
      .querySelector('[data-tour="feishu-enable"] .ant-switch')
      ?.classList.contains('ant-switch-checked')
    if (!switchOn) return 'enable-feishu'
    // 飞书已开启：依次引导填 App ID → App Secret → 发布；已发布（出现「停止」按钮）则收尾。
    if (elVisible('[data-tour="agent-stop"]')) return null
    if (!inputValue('[data-tour="feishu-app-id"]')) return 'enter-app-id'
    if (!inputValue('[data-tour="feishu-app-secret"]')) return 'enter-app-secret'
    return 'publish'
  }
  return null
}

// 在这些步骤之后变为 null（飞书已开启并发布完成）→ 视为整个引导完成。
// 仅这些步骤的目标在 zoom 动画的 Modal 内，需稳定性门控；其余步骤即时显示。
// App ID / App Secret 自渠道卡片改版后也移入了配置弹窗，同样需要门控，
// 否则聚光灯会在 zoom 动画中途量错位置。
const MODAL_STEPS: StepId[] = ['pick-template', 'choose-method', 'enter-app-id', 'enter-app-secret']

const FEISHU_STEPS: StepId[] = [
  'enable-feishu',
  'choose-method',
  'enter-app-id',
  'enter-app-secret',
  'publish',
]

export function OnboardingTour() {
  const { t } = useTranslation()
  const location = useLocation()
  const { active, complete, pause } = useOnboarding()
  const [stepId, setStepId] = useState<StepId | null>(null)
  const [ready, setReady] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const prevStepIdRef = useRef<StepId | null>(null)

  // 进行中时持续推导当前步骤：路由变化 + 轻量轮询（捕捉弹窗打开/关闭、key 输入等 DOM 变化）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: location 变化与轮询为推导触发，complete/pause 稳定
  useEffect(() => {
    if (!active) {
      setStepId(null)
      prevStepIdRef.current = null
      return
    }
    const tick = () => {
      const next = deriveStepId(location.pathname, location.search)
      setStepId(next)
      // 完成判定：之前在飞书步骤，仍停在飞书发布页，且现在已发布（推导出 null = 出现「停止」按钮）→ 收尾。
      // 要求 publishTab 仍为 feishu，避免「在发布步切到其它发布子页」被误判为完成。
      const sp = new URLSearchParams(location.search)
      if (
        next === null &&
        prevStepIdRef.current &&
        FEISHU_STEPS.includes(prevStepIdRef.current) &&
        /^\/agents\/agt_/.test(location.pathname) &&
        sp.get('tab') === 'publish' &&
        sp.get('publishTab') === 'feishu'
      ) {
        complete()
        setShowDone(true)
        return
      }
      prevStepIdRef.current = next ?? prevStepIdRef.current
    }
    tick()
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [active, location.pathname, location.search])

  // 稳定性门控：仅弹窗步骤（目标在 zoom 动画的 Modal 里）需要等位置稳定后再显示，避免「先错位
  // 出现→再位移」。其余步骤目标即时稳定，立刻就绪并保持 ready=true——避免每次切步都 reset 导致
  // run 抖动（步骤 7→8 的闪烁正源于此）。
  useEffect(() => {
    if (!active || !stepId) {
      setReady(false)
      return
    }
    if (!MODAL_STEPS.includes(stepId)) {
      setReady(true)
      return
    }
    setReady(false)
    const sel = STEP_TARGET[stepId]
    let lastKey = ''
    let stable = 0
    // 用 setInterval（而非 rAF）：后台标签 rAF 会被节流到几乎不跑，setInterval 仍会推进。
    const id = window.setInterval(() => {
      const el = document.querySelector(sel)
      if (!el) {
        stable = 0
        return
      }
      const r = el.getBoundingClientRect()
      const key = `${Math.round(r.top)},${Math.round(r.left)},${Math.round(r.width)}`
      if (r.width > 0 && key === lastKey) {
        stable += 1
        if (stable >= 2) {
          setReady(true)
          window.clearInterval(id)
        }
      } else {
        stable = 0
        lastKey = key
      }
    }, 60)
    // 兜底：极端情况下位置始终判不稳（动画卡住/异常）也最多 900ms 后照常显示，绝不卡住引导。
    const fallback = window.setTimeout(() => {
      setReady(true)
      window.clearInterval(id)
    }, 900)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(fallback)
    }
  }, [active, stepId])

  // 仅随语言变化重建：Joyride 是受控组件，频繁轮询推进 stepIndex 时若每次 render 都传新 steps
  // 数组（含 React node content），会带来不必要的对象抖动/重算。
  const steps: Step[] = useMemo(
    () => [
      {
        target: '[data-tour="nav-agents"]',
        placement: 'right',
        title: t('onboarding.navStepTitle'),
        content: t('onboarding.navStepDesc'),
      },
      {
        target: '[data-tour="new-agent-btn"]',
        placement: 'bottom',
        title: t('onboarding.step1Title'),
        content: t('onboarding.step1Desc'),
      },
      {
        target: '[data-tour="tpl-newbie"]',
        placement: 'bottom',
        title: t('onboarding.step2Title'),
        content: t('onboarding.step2Desc'),
      },
      {
        target: '[data-testid="provider-chain-api-key-0"]',
        placement: 'bottom',
        title: t('onboarding.step3Title'),
        content: (
          <span>
            {t('onboarding.step3Desc')}{' '}
            <strong style={{ fontWeight: 600, color: 'var(--color-foreground)' }}>
              {t('onboarding.step3Security')}
            </strong>
          </span>
        ),
      },
      {
        target: '[data-tour="agent-submit"]',
        placement: 'top',
        title: t('onboarding.step4Title'),
        content: t('onboarding.step4Desc'),
      },
      {
        target: '[data-tour="feishu-enable"]',
        placement: 'bottom',
        title: t('onboarding.step5Title'),
        content: t('onboarding.step5Desc'),
      },
      {
        target: '[data-tour="feishu-setup"]',
        placement: 'bottom',
        title: t('onboarding.feishuChooseTitle'),
        content: t('onboarding.feishuChooseDesc'),
      },
      {
        target: '[data-tour="feishu-app-id"]',
        placement: 'bottom',
        title: t('onboarding.appIdTitle'),
        content: t('onboarding.appIdDesc'),
      },
      {
        target: '[data-tour="feishu-app-secret"]',
        placement: 'bottom',
        title: t('onboarding.appSecretTitle'),
        content: t('onboarding.appSecretDesc'),
      },
      {
        target: '[data-tour="publish-btn"]',
        placement: 'top',
        title: t('onboarding.publishTitle'),
        content: t('onboarding.publishDesc'),
      },
    ],
    [t],
  )

  const stepIndex = stepId ? STEP_IDS.indexOf(stepId) : -1

  return (
    <>
      <Joyride
        steps={steps}
        run={active && stepIndex >= 0 && ready}
        stepIndex={Math.max(0, stepIndex)}
        continuous
        locale={{ close: t('common.close') }}
        tooltipComponent={OnboardingTooltip}
        // 目标可能在弹窗 zoom 动画中（如模板选择、飞书接入弹窗），用 animationFrame 每帧跟踪，
        // 让高亮框与气泡随目标位置实时校正，避免「测早了 → 高亮偏移」。
        floatingOptions={{ autoUpdate: { animationFrame: true } }}
        options={{
          buttons: ['close'],
          blockTargetInteraction: false,
          overlayClickAction: false,
          closeButtonAction: 'close',
          skipBeacon: true,
          targetWaitTimeout: 8000,
          disableFocusTrap: true,
          spotlightPadding: 6,
          spotlightRadius: 8,
          zIndex: 1100,
          primaryColor: 'var(--color-primary)',
          // 箭头与气泡同色（卡片底色），消除尖角与矩形之间的边框接缝。
          arrowColor: 'var(--color-card)',
        }}
        onEvent={(data) => {
          // 用户主动关闭（X）= 暂停（不标记完成，下次仍可从仪表盘/头部入口重开）。
          if (data.action === ACTIONS.CLOSE || data.type === EVENTS.TOUR_END) {
            if (data.action === ACTIONS.CLOSE) pause()
          }
        }}
      />

      {/* 发布成功后：祝贺并引导去飞书对话，作为整个引导的收尾。 */}
      <Modal
        open={showDone}
        footer={null}
        width={420}
        closable={false}
        onCancel={() => setShowDone(false)}
      >
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-brand-gradient-subtle text-interactive-foreground">
            <PartyPopper className="h-6 w-6" aria-hidden="true" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">{t('onboarding.doneTitle')}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t('onboarding.doneDesc')}
          </p>
          <div className="mt-6">
            <Button size="lg" onClick={() => setShowDone(false)}>
              {t('onboarding.doneBtn')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
