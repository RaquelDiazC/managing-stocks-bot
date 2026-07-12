# managing-stocks-bot ☁️

Bot de alertas 24/7 da plataforma [managing-stocks.app](https://managing-stocks.app) —
roda de graça no GitHub Actions a cada ~10 minutos, **com o PC desligado**, e notifica
no Telegram.

## O que vigia
- **BTC, ETH, SOL, XRP, XLM, DOGE** (Binance): variação 24h ≥5%, RSI(1h) sobrevendido/
  sobrecomprado, gatilhos de preço, **sinais de trade** (cruzamento MACD adaptativo na
  zona + virada de tendência HiLo 34 — a mesma matemática dos scripts Pine do TradingView)
- **Memecoins** (DexScreener): movimento forte (±10% em 1h, ±25% em 24h) e **guarda
  anti-rug** (liquidez abaixo de $20k)
- Saúde do site

## Configurar (uma vez)
1. No Telegram: fale com **@BotFather** → `/newbot` → guarde o token
2. Mande qualquer mensagem ("oi") para o seu bot novo
3. Nos *Settings → Secrets and variables → Actions* deste repo, crie:
   - `TELEGRAM_TOKEN` = o token do BotFather
   - `TELEGRAM_CHAT_ID` = seu chat id (pegue em `https://api.telegram.org/bot<TOKEN>/getUpdates` depois do passo 2)

Regras (limiares, moedas, gatilhos) em `config.json`. Sem Telegram configurado, o bot
roda e registra os alertas apenas no log da execução.

*Não é aconselhamento financeiro — é monitoramento automático de dados públicos.*
