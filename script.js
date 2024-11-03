const dino = document.getElementById("dino");
const win_screen = document.getElementById("win_screen");
const cactus = document.getElementById("cactus");

var cactusTop = function(){ return parseInt(window.getComputedStyle(cactus).getPropertyValue("top"));}

var jumps = 0;
var in_jump = false;

document.addEventListener("keydown", function(event) {
    jump();
});

document.addEventListener("click", function(event) {
	    jump();
});

function restartGame(){
    document.getElementById("restartButton").hidden = true;
    jumps = 0;
    win_screen.innerText = "";
    document.getElementById("game").hidden = false;
}

function jump (){
    if(dino.classList != "jump") {
        dino.classList.add("jump")
    }
    setTimeout(function (){
        dino.classList.remove("jump")
    }, 1200)
    
}

let life = setInterval (function(){
    var dinotop = parseInt(window.getComputedStyle(dino).getPropertyValue("top"));
    var cactusleft = parseInt(window.getComputedStyle(cactus).getPropertyValue("left"));

    if (cactusleft < 50 && cactusleft > 0 && dinotop >= 140) {
        //alert("GAME OVER!")
        win_screen.innerText = "проиграл!!";
        
        document.getElementById("game").hidden = true;
        document.getElementById("restartButton").hidden = false;
        
    }



}, 10)

var pruc = setInterval (function(){

    var dinotop = parseInt(window.getComputedStyle(dino).getPropertyValue("top"));
    if (dinotop < cactusTop())
    {
        if (in_jump == false)
        {
            in_jump = true;
            jumps ++;
            win_screen.innerText =jumps;
        }
    } else
    {
        in_jump = false;
    }
}, 1) 
