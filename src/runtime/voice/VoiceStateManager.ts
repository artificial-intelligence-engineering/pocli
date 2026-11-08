import { EventEmitter } from 'node:events';

export type VoiceTurnState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'PAUSED';

export type LegacyVoiceState = 'idle' | 'listening' | 'transcribing' | 'speaking' | 'muted';

export interface VoiceStateTransitionEvent {
  from: VoiceTurnState;
  to: VoiceTurnState;
  legacyState: LegacyVoiceState;
  timestamp: number;
  reason?: string;
}

/**
 * Manages the state machine for hands-free voice conversation turns:
 * IDLE | LISTENING -> PROCESSING -> SPEAKING -> LISTENING | PAUSED
 */
export class VoiceStateManager extends EventEmitter {
  private currentState: VoiceTurnState = 'IDLE';

  constructor(initialState: VoiceTurnState = 'IDLE') {
    super();
    this.currentState = initialState;
  }

  public getState(): VoiceTurnState {
    return this.currentState;
  }

  public getLegacyState(): LegacyVoiceState {
    return VoiceStateManager.toLegacyState(this.currentState);
  }

  public static toLegacyState(state: VoiceTurnState): LegacyVoiceState {
    switch (state) {
      case 'IDLE':
        return 'idle';
      case 'LISTENING':
        return 'listening';
      case 'PROCESSING':
        return 'transcribing';
      case 'SPEAKING':
        return 'speaking';
      case 'PAUSED':
        return 'muted';
    }
  }

  public static fromLegacyState(legacy: LegacyVoiceState): VoiceTurnState {
    switch (legacy) {
      case 'idle':
        return 'IDLE';
      case 'listening':
        return 'LISTENING';
      case 'transcribing':
        return 'PROCESSING';
      case 'speaking':
        return 'SPEAKING';
      case 'muted':
        return 'PAUSED';
    }
  }

  public transitionTo(next: VoiceTurnState, reason?: string): boolean {
    if (this.currentState === next) {
      return false;
    }
    const prev = this.currentState;
    this.currentState = next;
    const evt: VoiceStateTransitionEvent = {
      from: prev,
      to: next,
      legacyState: this.getLegacyState(),
      timestamp: Date.now(),
      reason,
    };
    this.emit('transition', evt);
    this.emit('state_change', evt.legacyState, evt.to);
    return true;
  }

  public isIdle(): boolean {
    return this.currentState === 'IDLE';
  }

  public isListening(): boolean {
    return this.currentState === 'LISTENING';
  }

  public isProcessing(): boolean {
    return this.currentState === 'PROCESSING';
  }

  public isSpeaking(): boolean {
    return this.currentState === 'SPEAKING';
  }

  public isPaused(): boolean {
    return this.currentState === 'PAUSED';
  }

  public isActive(): boolean {
    return this.currentState !== 'IDLE' && this.currentState !== 'PAUSED';
  }

  public isActiveConversation(): boolean {
    return this.isActive();
  }

  public setFromLegacyState(legacy: LegacyVoiceState, reason?: string): boolean {
    return this.transitionTo(VoiceStateManager.fromLegacyState(legacy), reason);
  }
}
