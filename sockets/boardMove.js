(function(exports) {
  "use strict";

  // expose variable
  var async = require("async");
  var stdlib = require("./stdlib");
  var mongoose = require('mongoose');
  var User = require("../models/user");
  var Board = require("../models/board");
  var List = require("../models/list");
  var Card = require("../models/card");
  var MemberRelation = require("../models/boardMemberRelation");

  exports.init = function(socket) {
    /**
     * Move Card to another board
     * Arguments:
     * - data: an object containing following attributes.
     *   - boardId: holds the target list's boardId.
     *   - listId: holds the target list's Id.
     *   - position: holds the list's update position.
     * - origCard: move card's original object
     * - updateCard: move card's update object
     */
    socket.on("move-card", function(data){
      _moveCardToBoard(data, function(err, origCard, updateCard){
        if (err) throw Error('move-card err:'+err);

        var origBoardId = origCard.boardId;
        var updateBoardId = updateCard.boardId;
        var isSameBoard = (origBoardId.toString('utf-8') == updateBoardId.toString('utf-8'));

        var eventRoomName = "board:" + updateBoardId;
        var updateEventName = "/card/" + updateCard._id +":update";
        var removeEventName = "/card/" + updateCard._id +":delete";
        var createEventName = "/card:move";
        var eventName = (isSameBoard === true) ? updateEventName : createEventName;

        updateCard.getBadges(function(err, badges) {
          var badgesCard = updateCard.toJSON();
          badgesCard.badges = badges;

          if ( isSameBoard == true ) {
            socket.room.emit(eventName, badgesCard);
          } else {
            socket.broadcast.to(eventRoomName).emit(eventName, badgesCard);
            socket.room.emit(removeEventName, badgesCard);
          }
        });
        
      });
    });

    /*
     * Move List to another board
     *
     * Arguments:
     * - data: an object containing following attributes.
     *   - boardId: holds the target list's boardId.
     *   - listId: holds the target list's Id.
     *   - position: holds the list's update position.
     */
    socket.on("move-list", function(data) {
      _moveListToBoard(data, function(err, origList, updateList){
        if (err) throw new Error('move-list err:'+err);

        var origBoardId = origList.boardId;
        var updateBoardId = updateList.boardId;
        var isSameBoard = (origBoardId.toString('utf-8') == updateBoardId.toString('utf-8'));

        var eventRoomName = "board:"+updateBoardId;
        var updateEventName = "/list/" +updateList._id+":update";
        var removeEventName = "/list/" +updateList._id+":delete";
        var createEventName = "/list:move";
        var eventName = (isSameBoard == true) ? updateEventName : createEventName;
        if ( isSameBoard == true ) {
          socket.room.emit(eventName, updateList);
        } else {
          socket.broadcast.to(eventRoomName).emit(eventName, updateList);
          socket.room.emit(removeEventName, updateList);
        }

      });
    });
  };


  /**
   *  Private methods
   *  moveCardToBoard
   **/
  var _moveCardToBoard = function(data, callback ){
    async.waterfall([

      //workflow
      // 1. get move card object
      function(callback) {
        Card.findById(data.cardId, function(err, origCard){
          callback(err, origCard);
        })
      },

      // 2. get all cards order of the target list
      function(origCard, callback){
        Card.find({listId: data.listId}).sort({'order': 1}).select('order')
      .exec(function(err, targetCardOrders){
        callback(err, origCard, targetCardOrders);
      });
      },

      // 3. get original list model from target move card model.
      function(origCard, targetCardOrders, callback){
        List.findById(origCard.listId, function(err, origList){
          callback(err, origCard, targetCardOrders, origList);
        });
      },

      // 4. update the card's order
      function(origCard, targetCardOrders, origList, callback){
        var order = _updateMoveCardOrder(data, origCard, targetCardOrders, origList);
        callback(null, origCard, origList, order);
      },

      // 5. update card's listId, baordId and order
      function(origCard, origList, order, callback){
        Card.findByIdAndUpdate(origCard._id, {'listId': data.listId,'boardId': data.boardId, 'order': order}, function(err, updateCard){
          callback(err, origCard, updateCard);
        });
      },

      //As a board memeber I can move a card to a list in another board
      //without its assignee.
      function(origCard,updateCard,callback){
        var origBoardId = origCard.boardId;
        var updateBoardId = updateCard.boardId;
        var isSameBoard = (origBoardId.toString('utf-8') == updateBoardId.toString('utf-8'));

        //if the board is another board, remove assignees
        if (!isSameBoard) {
          Card.findByIdAndUpdate(origCard._id, {'assignees': []}, function(err, updateCard){
            callback(err, origCard, updateCard);
          });
        } else {
          callback(null, origCard, updateCard);
        }
      }
    ], function(err ,origCard, updateCard){
      callback(err, origCard, updateCard);
    });
  };

  //calc the move card's order
  var _updateMoveCardOrder = function( data, origCard, targetCardOrders, origList){
    var order = 65536-1;
    var moveIndex = data.position >= 0 ? (data.position -1) : 0;
    var lastIndex = targetCardOrders.length == 0 ? 0: (targetCardOrders.length - 1);
    var cardCount = targetCardOrders.length;
    var origListId = origCard.listId;
    var newListId = data.listId;
    var isSameList = (origListId.toString('utf-8') == newListId.toString('utf-8'));


    // either in one list or move to new list
    // 1.move card to new list, the list have no card right now.
    if ( cardCount === 0 && moveIndex === 0 ) {
      order = origCard.order + 65536;

      // either in one list or move to new list
      //case2: move to frist index of card array
    } else if ( cardCount > 0 && moveIndex === 0 ) {
      var movetoOrder = targetCardOrders[moveIndex].order;
      order = movetoOrder /2;

      //move to new list,we need consider a  boundary,
      //move to middle of position,the other cards
      //will subsequent move to next order, so we don't need to
      //check if last order is undefined
      //case3: move to inPosition of card array
    } else if (!isSameList && cardCount > 0 &&
      typeof targetCardOrders[moveIndex - 1] != 'undefined' &&
      typeof targetCardOrders[moveIndex] != 'undefined') {
        var beforeOrder = targetCardOrders[moveIndex - 1].order;
        var movetoOrder = targetCardOrders[moveIndex].order;
        order = (beforeOrder + movetoOrder) /2;

        // either in one list or move to new list
        //case4: move to new list, last index of card array
      } else if ( isSameList && cardCount > 0 &&
        moveIndex === lastIndex) {
          var movetoOrder = targetCardOrders[moveIndex].order;
          order = movetoOrder + 65536;

          // case 5-1: in one list, move from top to bottom
        } else if ( isSameList && cardCount > 0 &&
          typeof targetCardOrders[moveIndex -1] != 'undefined' &&
          typeof targetCardOrders[moveIndex] != 'undefined' &&
          typeof targetCardOrders[moveIndex +1] != 'undefined' &&
          origCard.order < targetCardOrders[moveIndex].order ) {
            var movetoOrder = targetCardOrders[moveIndex].order;
            var afterOrder = targetCardOrders[moveIndex + 1].order;
            order = (movetoOrder + afterOrder) /2;

            // case 5-2: in one list, move bottom to top
        } else if ( isSameList && cardCount > 0 &&
          typeof targetCardOrders[moveIndex -1] != 'undefined' &&
          typeof targetCardOrders[moveIndex] != 'undefined' &&
          typeof targetCardOrders[moveIndex +1] != 'undefined' &&
          origCard.order > targetCardOrders[moveIndex].order) {
            var beforeOrder = targetCardOrders[moveIndex - 1].order;
            var movetoOrder = targetCardOrders[moveIndex].order;
            order = (beforeOrder + movetoOrder) /2;
          }

    return order;
  };

  var _moveListToBoard = function( data, callback ){
    async.waterfall([
      // - get original list object
      function(callback) {
        List.findById(data.listId, function(err, origList){
          callback(err,origList);
        });
      },

      // - get all lists from target board
      function(origList,callback){
        List.find({boardId: data.boardId}).sort('order').select('order')
      .exec(function(err, targetListOrders) {
        callback(err, origList, targetListOrders);
      });
      },

      // - calc the list's order
      function( origList, targetListOrders, callback){
        var order = _updateMoveListOrder(data,  origList, targetListOrders);
        callback(null, order, origList);
      },

      // - boardcast the update list to target board
      function(order, origList, callback){
        List.findByIdAndUpdate(origList._id,{'boardId': data.boardId, 'order': order}, function(err, updateList){
          callback(err, origList, updateList);
        });
      },
      //- update relative card's relation with the update list
      function( origList, updateList, callback){
        Card.update({'listId': updateList.id}, {$set: {'boardId': data.boardId}}, { multi: true }, function(err){
          callback(err,  origList, updateList);
        });
      }
    ], function(err, origList, updateList){
      callback(err, origList, updateList);
    });
  };

  var _updateMoveListOrder = function(data, origList, targetListOrders){
    var order = 65536-1;
    var moveIndex = data.position >= 0 ? (data.position-1) : 0;
    var lastIndex = targetListOrders.length == 0 ? 0: (targetListOrders.length - 1);
    var origBoardId = origList.boardId;
    var updateBoardId = data.boardId;
    var isSameBoard = (origBoardId.toString('utf-8') == updateBoardId.toString('utf-8'));
    var inListOrder = (lastIndex == 0) ? order  : targetListOrders[moveIndex].order;

    // case 1: the board have no list
    if (targetListOrders.length == 0 && moveIndex == 0) {
      return origList.order + order;
    }

    // case 2: the baord have list, move to head, index 0
    else if (targetListOrders.length > 0 && moveIndex == 0) {
      order = targetListOrders[moveIndex].order / 2;
    }

    //case 4, same board, move in middle of position in one board.
    else if ( isSameBoard == true &&
               moveIndex > 0 && 
               moveIndex < lastIndex ) {

      if ( origList.order < inListOrder ) {
        order = (inListOrder + targetListOrders[moveIndex + 1].order) /2;
      } else if ( origList.order > inListOrder) {
        order = ( targetListOrders[moveIndex - 1].order + inListOrder) /2;
      }
    }
    //case 6, same baord, move to last position
    else if ( isSameBoard == true && moveIndex == lastIndex ) {
      order = targetListOrders[lastIndex].order + 65536;
    }

    // case 3, move to another board, the target board have more than 0 list.
    //case 5, different board, move in imddle of position in two baord.
    else if (isSameBoard == false &&
              moveIndex > 0 &&
              moveIndex <= lastIndex ) {
      order = (targetListOrders[moveIndex - 1].order + inListOrder) /2;
    }

    return order;
  }

}(exports));
