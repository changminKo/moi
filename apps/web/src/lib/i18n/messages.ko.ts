import type { MessageKey } from './messages.en';

// Korean message catalogue — the product default. Keys are defined by the
// English reference bundle so a missing translation is a type error.
export const ko: Record<MessageKey, string> = {
  'app.brandAria': 'Moi — 거래로 이동',
  'app.navAria': '주요 메뉴',
  'app.navTrade': '거래',
  'app.navPortfolio': '포트폴리오',
  'app.localeSwitchAria': '언어 선택',

  'session.loading': '세션을 불러오는 중…',
  'session.retry': '세션 다시 시작',

  'banner.systemStatusAria': '거래 시스템 상태',
  'common.retry': '다시 시도',
  'common.dismiss': '닫기',
  'common.close': '닫기',
  'common.cancel': '취소',

  'instruments.title': '종목 검색',
  'instruments.searchLabel': '검색',
  'instruments.searchPlaceholder': '종목명 · 티커 검색',
  'instruments.nonTradable': '거래 불가',
  'instruments.showAll': '전체 보기',

  'quote.empty': '종목을 선택하면 시세가 표시됩니다.',
  'quote.timestamp': '기준 시각',
  'quote.bookTitle': '호가',
  'quote.bookTitleWithCurrency': '호가 · {{currency}}',
  'quote.asks': '매도 호가',
  'quote.bids': '매수 호가',
  'quote.ask': '매도',
  'quote.bid': '매수',
  'quote.noAsks': '매도 호가 없음',
  'quote.noBids': '매수 호가 없음',
  'quote.sparklineCollecting': '차트 데이터 수집 중…',
  'quote.sparklineSummary': '최근 {{count}}틱, 최고 {{high}}, 최저 {{low}}',
  'quote.sparklineSummaryPartial':
    '{{window}}틱 중 {{count}}틱 수집, 최고 {{high}}, 최저 {{low}}',
  'quote.chartWindow': '차트 구간',
  'quote.chartWindowOption': '{{count}}틱',

  'ticket.title': '주문',
  'ticket.side': '구분',
  'ticket.buy': '매수',
  'ticket.sell': '매도',
  'ticket.orderType': '주문 유형',
  'ticket.type': '유형',
  'ticket.typeMarket': '시장가',
  'ticket.typeLimit': '지정가',
  'ticket.typeStop': '스탑',
  'ticket.typeTakeProfit': '익절',
  'ticket.typeOco': 'OCO',
  'ticket.quantity': '수량',
  'ticket.price': '가격',
  'ticket.triggerPrice': '트리거 가격',
  'ticket.stopPrice': '스탑 가격',
  'ticket.estimate': '예상 금액 ≈ {{amount}}',
  'ticket.estimateRange': '예상 금액 ≈ {{low}} ~ {{high}}',
  'ticket.estimateUnavailable': '예상 금액 — 계산할 시세가 없습니다',
  'ticket.place': '주문하기',
  'ticket.placeAria': '주문 — 주문하기',
  'ticket.invalidOrder': '잘못된 주문입니다',
  'ticket.rejected': '주문이 거부되었습니다',
  'ticket.placedOpen': '주문이 접수되었습니다.',
  'ticket.placedPendingTrigger':
    '주문이 접수되었습니다. 트리거 가격에 도달하면 실행됩니다.',
  'ticket.rejectedWithCode': '주문이 거부되었습니다 (코드: {{code}})',
  'ticket.requestId': '요청 ID: {{requestId}}',

  'validation.quantity': '수량은 양의 정수여야 합니다',
  'validation.limitPrice': '지정가를 입력하세요',
  'validation.stopPrice': '스탑 가격을 입력하세요',
  'validation.triggerPrice': '트리거 가격을 입력하세요',
  'validation.takeProfitPrice': '익절 가격을 입력하세요',
  'validation.ocoTriggersDiffer': 'OCO 트리거 가격은 서로 달라야 합니다',

  // `POST /api/v1/orders` 공개 오류 코드 (docs/api/error-contract.md). 아래
  // `reason.*` 와는 별도의 목록이다: reason 은 거래가 왜 제한되는지를,
  // 여기 있는 문장은 이 주문이 왜 거부되었는지를 말한다.
  'orderError.SYMBOL_NOT_TRADABLE': '거래할 수 없는 종목입니다',
  'orderError.MARKET_CLOSED': '장이 열려 있지 않습니다',
  'orderError.MARKET_DATA_DEGRADED': '시세가 지연되어 주문을 받을 수 없습니다',
  'orderError.RECOVERY_IN_PROGRESS':
    '시세 복구 중입니다 — 잠시 후 다시 시도하세요',
  'orderError.CANCEL_ONLY': '안전 모드: 취소만 가능합니다',
  'orderError.ACCOUNT_READ_ONLY': '계정이 보호 잠금 상태입니다',
  'orderError.SERVICE_UNAVAILABLE':
    '서비스를 이용할 수 없습니다 — 잠시 후 다시 시도하세요',
  'orderError.INSUFFICIENT_AVAILABLE_CASH': '주문 가능 금액이 부족합니다',
  'orderError.INSUFFICIENT_AVAILABLE_POSITION':
    '매도할 수 있는 수량이 부족합니다',
  'orderError.PRICE_PROTECTION':
    '가격 보호로 거부되었습니다 — 시세가 너무 많이 벌어졌습니다',
  'orderError.IDEMPOTENCY_CONFLICT': '이미 보낸 요청과 충돌합니다',
  'orderError.RATE_LIMITED': '요청이 너무 많습니다 — 잠시 후 다시 시도하세요',
  'orderError.CAPACITY_REACHED':
    '미체결 주문이 너무 많습니다 — 먼저 하나를 취소하세요',
  'orderError.INVALID_QUANTITY': '수량이 올바르지 않습니다',
  'orderError.INVALID_PRICE': '가격이 올바르지 않습니다',
  'orderError.INVALID_ORDER': '주문 내용이 올바르지 않습니다',
  'orderError.VALIDATION_ERROR': '입력한 내용으로는 주문을 받을 수 없습니다',
  'orderError.SESSION_EXPIRED': '세션이 만료되었습니다 — 새 세션을 시작하세요',
  'orderError.FORBIDDEN': '허용되지 않은 동작입니다',
  'orderError.PAYLOAD_TOO_LARGE': '요청이 너무 큽니다',
  'orderError.INVARIANT_VIOLATION':
    '주문을 처리할 수 없었습니다 — 주문은 접수되지 않았습니다',
  'orderError.INTERNAL_ERROR':
    '문제가 발생했습니다 — 주문은 접수되지 않았습니다',

  'wallet.title': '지갑',
  'wallet.available': '주문 가능',
  'wallet.reserved': '예약 중',
  'wallet.total': '총액',

  'fx.title': '가상 환전',
  'fx.amount': '금액',
  'fx.getQuote': '환율 조회',
  'fx.convert': '환전하기',
  'fx.rate': '환율',
  'fx.rateValue': '1 {{to}} ≈ {{krw}} {{from}}',
  'fx.fee': '수수료',
  'fx.source': '보내는 금액',
  'fx.destination': '받는 금액',
  'fx.amountPositive': '금액은 0보다 커야 합니다',
  'fx.quoteExpired': '환율이 만료되었습니다. 다시 조회하세요.',
  'fx.insufficient': '주문 가능 금액이 부족합니다',
  'fx.failed': '환전에 실패했습니다',

  'portfolio.loading': '포트폴리오를 불러오는 중…',
  'portfolio.title': '포트폴리오',
  'portfolio.eyebrow': '계좌 / 02',
  'positions.title': '보유 종목',
  'positions.empty': '보유 종목이 없습니다.',
  'positions.caption': '주문 가능·예약 수량과 평균 단가',
  'positions.symbol': '종목',
  'positions.available': '주문 가능',
  'positions.reserved': '예약 중',
  'positions.total': '총 수량',
  'positions.avgCost': '평균 단가',
  'positions.closedTitle': '청산한 종목',
  'positions.closedCaption': '전량 매도한 종목과 보유 당시 평균 단가',
  'positions.closedAvgCost': '보유 당시 평균 단가',

  'orders.title': '미체결 주문',
  'orders.empty': '미체결 주문이 없습니다.',
  'orders.filled': '체결',
  'orders.remaining': '잔여',
  'orders.ocoSibling': 'OCO 연결 주문',
  'orders.cancelFailed': '취소에 실패했습니다',

  'fills.title': '체결 내역',
  'fills.empty': '체결 내역이 없습니다.',
  'fills.fee': '수수료',
  'fills.recovery': '복구 체결',

  'amend.title': '주문 정정',
  'amend.save': '변경 저장',
  'amend.unavailable': '정정할 수 없는 주문입니다.',

  // Trading reason codes. Both catalogues are typed against the same key
  // set, so a code translated in one language and not the other is a
  // compile error rather than a blank panel at runtime.
  'reason.MARKET_DATA_DEGRADED': '시세가 지연되고 있습니다',
  'reason.RECOVERY_IN_PROGRESS': '복구가 진행 중입니다',
  'reason.CANCEL_ONLY': '안전 모드: 취소만 가능합니다',
  'reason.ACCOUNT_READ_ONLY': '계정 보호 잠금',
  'reason.UNAVAILABLE': '서비스를 이용할 수 없습니다',
  'reason.SERVICE_UNAVAILABLE': '서비스를 이용할 수 없습니다',
  'reason.SESSION_EXPIRED': '세션이 만료되었습니다 — 새 세션을 시작하세요',
  'reason.SYMBOL_NOT_TRADABLE': '거래할 수 없는 종목입니다',

  'holding.available': '주문 가능 {{available}}주',
  'holding.availableReserved':
    '주문 가능 {{available}}주 · 예약 중 {{reserved}}주',
  'holding.none': '보유 없음',

  'fillToast.regionAria': '체결 알림',
  'fillToast.complete':
    '{{symbol}} {{side}} {{quantity}}주 체결 · {{price}} · 주문 완료',
  'fillToast.partial':
    '{{symbol}} {{side}} {{quantity}}주 체결 · {{price}} · {{filled}}/{{total}}',
  'fillToast.completeCumulative': '{{symbol}} {{side}} {{total}}주 전량 체결',
  'fillToast.partialCumulative':
    '{{symbol}} {{side}} {{filled}}/{{total}}주 체결',

  'guard.unavailable': '지금은 이용할 수 없습니다',
};
