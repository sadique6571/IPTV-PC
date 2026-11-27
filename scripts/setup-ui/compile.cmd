@echo off
setlocal
set "fx=%SystemRoot%\Microsoft.NET\Framework\v4.0.30319"
"%fx%\csc.exe" /nologo /target:winexe /platform:anycpu /optimize+ /out:"%~1" /win32icon:"%~dp0..\..\assets\icon.ico" /resource:"%~dp0Wizard.xaml",Wizard.xaml /resource:"%~dp0..\..\assets\icon.png",icon.png /reference:"%fx%\WPF\PresentationFramework.dll" /reference:"%fx%\WPF\PresentationCore.dll" /reference:"%fx%\WPF\WindowsBase.dll" /reference:"%fx%\System.Xaml.dll" "%~dp0Wizard.cs"
exit /b %errorlevel%
