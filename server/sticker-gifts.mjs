// Sticker gifts in comments and messages span two databases: market.sqlite owns inventory, little-log.sqlite owns the content.
// Order: validate (no writes) -> move the sticker with a market receipt -> save the content -> settle the receipt.
// If saving fails the sticker is returned at once; reconcile() finishes gifts interrupted by a crash.
export function createStickerGifts(social,economy) {
  function send(kind,owner,input,write) { // write(owner,input,gift) is the social comment/message save.
    if(input?.sticker===undefined||input?.sticker===null)return write(owner,input); // Text-only content never touches the market.
    const {recipient,source}=social.stickerRecipient(owner,kind,input); // Same access, text and rate checks the save applies.
    const {sticker}=economy.gifts('give',owner,{source,recipient,sticker:input.sticker}); // Retries return the original transfer.
    let result;
    try {result=write(owner,input,{sticker,recipient});}
    catch(error) {
      try {if(!social.stickerContentSaved(owner,source))economy.gifts('return',owner,source);}catch { /* reconcile() decides on the next timer tick. */ } // A conflicting retry must not undo an already-saved gift.
      throw error;
    }
    try {economy.gifts('settle',owner,source);}catch { /* reconcile() settles saved content later. */ }
    return {...result,sticker};
  }
  function reconcile(olderThan=Date.now()-120000) { // Settle gifts whose content was saved; return the rest. Runs on the 30-second reward timer.
    let pending;try {pending=economy.gifts('unsettled',olderThan);}catch {return 0;} // Market receipts use the real clock; two minutes outlasts a 15-second request.
    for(const gift of pending) {
      try {economy.gifts(social.stickerContentSaved(gift.sender,gift.source)?'settle':'return',gift.sender,gift.source);}catch { /* Retry next tick. */ }
    }
    return pending.length;
  }
  return {
    comment:(owner,input)=>send('comment',owner,input,social.comment),
    sendMessage:(owner,input)=>send('message',owner,input,social.sendMessage),
    owned:owner=>{social.requireUser(owner);return economy.gifts('owned',owner);}, // Picker contents for live accounts: available sticker types and quantities.
    reconcile,
  };
}
