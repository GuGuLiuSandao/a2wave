import { confirm } from '@/lib/confirm'
import { Input } from 'antd'
import type { TFunction } from 'i18next'
import { useState } from 'react'
import { Trans } from 'react-i18next'

/**
 * Content for the delete-agent confirmation modal. The user must type the
 * agent's exact name before deletion is enabled, guarding against accidental
 * deletion. Calls back with whether the typed value matches.
 */
function DeleteAgentConfirmContent({
  agentName,
  t,
  onMatchChange,
}: {
  agentName: string
  t: TFunction
  onMatchChange: (match: boolean) => void
}) {
  const [value, setValue] = useState('')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 4 }}>
      <p style={{ margin: 0 }}>{t('agentDetail.deleteConfirmContent', { name: agentName })}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={{ margin: 0 }}>
          <Trans
            i18nKey="agentDetail.deleteTypeNameHint"
            values={{ name: agentName }}
            components={{ strong: <strong /> }}
          />
        </p>
        <Input
          autoFocus
          value={value}
          placeholder={agentName}
          onChange={(e) => {
            const next = e.target.value
            setValue(next)
            onMatchChange(next.trim() === agentName.trim())
          }}
        />
      </div>
    </div>
  )
}

/**
 * Opens a confirmation modal requiring the user to type the agent's name
 * before the destructive action is enabled. `onConfirm` runs only after a
 * matching name has been entered and the user confirms.
 */
export function confirmDeleteAgent(opts: {
  agentName: string
  t: TFunction
  onConfirm: () => Promise<void>
}) {
  const { agentName, t, onConfirm } = opts
  let matched = false

  const instance = confirm({
    title: t('agentDetail.deleteConfirmTitle'),
    okText: t('agentDetail.deleteOk'),
    danger: true,
    cancelText: t('agentDetail.deleteCancel'),
    okButtonProps: { disabled: true },
    content: (
      <DeleteAgentConfirmContent
        agentName={agentName}
        t={t}
        onMatchChange={(match) => {
          matched = match
          // antd's `update` replaces okButtonProps wholesale, so re-assert
          // `danger` here or the delete button loses its red fill on match.
          instance.update({ okButtonProps: { danger: true, disabled: !match } })
        }}
      />
    ),
    onOk: async () => {
      if (!matched) return Promise.reject()
      await onConfirm()
    },
  })
}
