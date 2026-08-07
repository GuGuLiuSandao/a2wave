import { Button } from '@/components/ui/button'
import { useOnboarding } from '@/hooks/use-onboarding'
import { Modal } from 'antd'
import { Rocket } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

/**
 * 新手引导入口（挂在仪表盘）：登录后若该用户未完成/未选择「不再提示」，弹欢迎弹窗，
 * 让用户选择「开始引导」或「不再提示」（不再提示带二次挽留）。
 *
 * 「开始引导」只置位 running（useOnboarding.start），具体分步引导由根部 OnboardingTour
 * 按应用状态推导显示（从仪表盘高亮左侧 Agents 开始）。完成态持久化在后端。
 */
export function OnboardingWelcome() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { done, active, isLoading, start, dismiss, reset } = useOnboarding()

  const [showWelcome, setShowWelcome] = useState(false)
  // 每次挂载只主动弹一次，避免暂停引导后立刻又弹出来打扰。
  const promptedRef = useRef(false)

  // 测试用：?onboarding=reset 清除后端完成态并去掉该参数，随后欢迎弹窗会重新出现。
  const resetRef = useRef(false)
  useEffect(() => {
    if (searchParams.get('onboarding') !== 'reset' || resetRef.current) return
    resetRef.current = true
    reset()
    const next = new URLSearchParams(searchParams)
    next.delete('onboarding')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams, reset])

  useEffect(() => {
    if (!isLoading && !done && !active && !promptedRef.current) {
      promptedRef.current = true
      setShowWelcome(true)
    }
  }, [isLoading, done, active])

  // antd 弹窗打开会自动聚焦首个可聚焦元素（主按钮），导致一打开就带 focus 圈。
  // 用双 rAF 等 antd 聚焦完成后取消它（键盘用户 Tab 仍可聚焦，focus-visible 不受影响）。
  useEffect(() => {
    if (!showWelcome) return
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = document.activeElement as HTMLElement | null
        if (el && el !== document.body) el.blur()
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [showWelcome])

  const handleStart = () => {
    setShowWelcome(false)
    start()
  }

  // 「暂不需要」/ ESC / 点遮罩 都直接持久化 dismissed：否则 done 仍为 false，下次登录又弹。
  // 用户随时可从 Agents 页右上角「新手引导」重开，故持久化 dismiss 不是死路。
  const handleDismiss = () => {
    setShowWelcome(false)
    dismiss()
  }

  return (
    <Modal open={showWelcome} footer={null} width={460} closable={false} onCancel={handleDismiss}>
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-brand-gradient-subtle text-interactive-foreground">
          <Rocket className="h-6 w-6" aria-hidden="true" />
        </div>
        <h3 className="text-lg font-semibold text-foreground">{t('onboarding.welcomeTitle')}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {t('onboarding.welcomeDesc')}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button size="lg" onClick={handleStart}>
            {t('onboarding.welcomeStart')}
          </Button>
          <Button size="lg" variant="ghost" onClick={handleDismiss}>
            {t('onboarding.welcomeDismiss')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
